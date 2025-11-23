// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::{anyhow, Result};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fmt::Display,
    hash::{Hash, Hasher},
};

#[expect(clippy::disallowed_types)]
use std::collections::HashMap;

use config::{FILL_CONSTANT_RATE, FILL_REUSE_RATE};
use libafl::{
    inputs::{BytesInput, HasMutatorBytes, Input, ResizableMutator},
    state::DEFAULT_MAX_SIZE,
};
use libafl_bolts::{rands::Rand, HasLen};
use serde::{Deserialize, Serialize};

use crate::{
    config::{MAX_COMPLETE_WITH_ENDPOINTS, MAX_COMPLETION_ITER},
    rng::TrySample,
    schema::{CallConvention, CanValidate, EndpointName, Schema, Signature, SignatureQuery, Type},
};
use crate::{rng::BytesRand, seq::HasSeqLen};

pub mod metrics;
pub mod rng;
pub mod schema;
pub mod seq;
pub mod shmem;

mod config;

pub type NodeId = usize;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ConstantValue {
    Number(f64),
    String(String),
    Boolean(bool),
    Object(BTreeMap<String, ConstantValue>),
    Array(Vec<ConstantValue>),
    Undefined,
    Null,
    Function,
}

#[derive(Serialize, Deserialize, Clone)]
pub enum NodePayload {
    Constant {
        typ: Type,
        value: ConstantValue,
    },
    Api {
        signature: Signature,
        name: EndpointName,
        #[serde(with = "serde_bytes")]
        context: Vec<u8>,
    },
}

impl std::fmt::Debug for NodePayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodePayload::Constant { typ, value } => {
                writeln!(f, "Constant {{")?;
                writeln!(f, "  typ: {:?}", typ)?;
                writeln!(f, "  value: {:?}", value)?;
                write!(f, "}}")
            }
            NodePayload::Api {
                signature, name, ..
            } => {
                writeln!(f, "Api {{")?;
                writeln!(f, "  name: {}", name)?;
                writeln!(f, "  signature: {:?}", signature)?;
                write!(f, "}}")
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IncomingEdge {
    pub src: NodeId,
    pub evaluation_order: usize,
    pub port: usize,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OutgoingEdge {
    pub dst: NodeId,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Node {
    pub id: NodeId,
    pub payload: NodePayload,
    pub incoming: Vec<IncomingEdge>,
    pub outgoing: Vec<OutgoingEdge>,

    /// Edges can only go from higher to lower depth. Fractional and negative depths let me perform
    /// mutations without having to traverse the graph and adjust depth for all other nodes.
    pub depth: f64,
}

impl Node {
    pub fn constant(id: NodeId, typ: Type, value: ConstantValue, depth: f64) -> Self {
        assert!(
            !matches!(typ, Type::Class(_)),
            "classes cannot be saved in constant nodes"
        );
        Self {
            id,
            outgoing: vec![],
            incoming: vec![],
            payload: NodePayload::Constant { typ, value },
            depth,
        }
    }

    pub fn api(
        id: NodeId,
        api: EndpointName,
        signature: Signature,
        context: Vec<u8>,
        depth: f64,
    ) -> Self {
        Self {
            id,
            payload: NodePayload::Api {
                signature,
                name: api,
                context,
            },
            outgoing: vec![],
            incoming: vec![],
            depth,
        }
    }

    fn next_eval_order(&self) -> usize {
        self.incoming
            .iter()
            .map(|inc| inc.evaluation_order)
            .max()
            .map(|v| v + 1)
            .unwrap_or(0)
    }

    pub fn get_type(&self) -> &Type {
        match &self.payload {
            NodePayload::Api { signature, .. } => &signature.ret,
            NodePayload::Constant { typ, .. } => typ,
        }
    }

    pub fn is_fulfilled(&self) -> bool {
        match &self.payload {
            NodePayload::Constant { .. } => {
                assert!(
                    self.incoming.is_empty(),
                    "constant nodes should have no incoming edges"
                );
                true
            }
            NodePayload::Api { signature, .. } => {
                debug_assert!(
                    {
                        let filled: HashSet<usize> =
                            self.incoming.iter().map(|inc| inc.port).collect();
                        filled.len() == self.incoming.len()
                    },
                    "invalid incoming edges: duplicate ports"
                );
                self.incoming.len() == signature.args.len()
            }
        }
    }

    fn get_filled_ports(&self) -> HashSet<usize> {
        self.incoming.iter().map(|inc| inc.port).collect()
    }

    pub fn is_const(&self) -> bool {
        match self.payload {
            NodePayload::Constant { .. } => true,
            NodePayload::Api { .. } => false,
        }
    }
}

impl Display for Node {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", serde_json::to_string_pretty(self).unwrap())
    }
}

pub trait HasSchema {
    fn schema(&self) -> &Schema;
    fn schema_mut(&mut self) -> &mut Schema;
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Graph {
    pub root: NodeId,
    pub nodes: BTreeMap<NodeId, Node>,
    schema: Schema,
}

impl HasSeqLen for Graph {
    fn seq_len(&self) -> usize {
        self.nodes.len()
    }
}

impl HasSchema for Graph {
    fn schema(&self) -> &Schema {
        &self.schema
    }

    fn schema_mut(&mut self) -> &mut Schema {
        &mut self.schema
    }
}

impl Graph {
    #[expect(clippy::disallowed_types)]
    fn get_node_types(&self) -> HashMap<Type, Vec<NodeId>> {
        let mut value_types = HashMap::<Type, Vec<NodeId>>::new();
        for node in self.nodes.values() {
            let typ = node.get_type();
            if value_types.contains_key(typ) {
                value_types.get_mut(typ).unwrap().push(node.id);
            } else {
                value_types.insert(typ.clone(), vec![node.id]);
            }
        }
        value_types
    }

    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    pub fn schema_mut(&mut self) -> &mut Schema {
        &mut self.schema
    }

    /// If the parametric generator tries to create a graph with a byte seq that's not even 8 bytes (we
    /// need atleast a u64 for BytesRand to work), use the fuzzer's seed to fill in rest of the bytes.
    /// This is because we can't really pass in state.rand_mut() here since this is called by both the
    /// harness and JS during replay. Filling in with the fuzzer seed is one way to still keep this
    /// deterministic.
    pub fn create_from_bytes(
        seed: u64,
        bytes: &[u8],
        schema: &Schema,
    ) -> Result<Graph, RailcarError> {
        if bytes.len() >= 8 {
            let mut rand = BytesRand::new(bytes);
            Graph::create(&mut rand, schema)
        } else {
            // Use big-endian bytes here. In most cases the seed won't be a huge number, so the array
            // returned by to_be_bytes() will have zeroes at the start, and then actual information. Write
            // `bytes` to the zero part to retain information in the seed. In all other places I use
            // little-endian by default.
            let mut seed_bytes = seed.to_be_bytes();
            seed_bytes[0..bytes.len()].copy_from_slice(bytes);

            let mut rand = BytesRand::new(&seed_bytes);
            Graph::create(&mut rand, schema)
        }
    }
}

impl Hash for Graph {
    fn hash<H: Hasher>(&self, state: &mut H) {
        #[expect(clippy::disallowed_methods)]
        let ser = rmp_serde::to_vec(self).expect("failed to serialize graph for hash");
        ser.hash(state);
    }
}

impl Input for Graph {
    fn to_file<P>(&self, path: P) -> Result<(), libafl::Error>
    where
        P: AsRef<std::path::Path>,
    {
        let serialized = rmp_serde::to_vec_named(self)
            .map_err(|e| libafl::Error::unknown(format!("failed to serialize input {}", e)))?;

        let size_in_bytes = serialized.len();
        if size_in_bytes > DEFAULT_MAX_SIZE {
            log::warn!(
                "input size is {} bytes which exceeds default max size hint.",
                size_in_bytes
            );
        }
        libafl_bolts::fs::write_file_atomic(path, &serialized)
    }

    fn from_file<P>(path: P) -> Result<Self, libafl::Error>
    where
        P: AsRef<std::path::Path>,
    {
        let file = std::fs::File::open(path)?;
        let deserialized = rmp_serde::from_read(file)
            .map_err(|e| libafl::Error::unknown(format!("failed to load input {}", e)))?;
        Ok(deserialized)
    }
}

fn noop(_: &Node) {}

#[derive(Debug)]
pub enum RailcarError {
    HugeGraph,
    Unknown(anyhow::Error),
}

impl Display for RailcarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RailcarError::HugeGraph => write!(f, "huge graph"),
            RailcarError::Unknown(msg) => write!(f, "{}", msg),
        }
    }
}

#[expect(clippy::disallowed_types)]
fn insert_or_append<K, V>(map: &mut HashMap<K, Vec<V>>, key: &K, value: V)
where
    K: Eq + Hash + Clone,
{
    if map.contains_key(key) {
        map.get_mut(key).unwrap().push(value);
    } else {
        map.insert(key.clone(), vec![value]);
    }
}

#[expect(clippy::disallowed_types)]
type TypeToNodeIds = HashMap<Type, Vec<usize>>;

impl Graph {
    fn seed<R: Rand>(rand: &mut R, schema: &Schema) -> Result<Self, RailcarError> {
        // pick a non built-in endpoint
        let keys: Vec<_> = schema
            .iter()
            .filter_map(|(key, sig)| {
                if let Some(builtin) = sig.builtin {
                    if builtin {
                        return None;
                    }
                }
                Some(key)
            })
            .collect();

        let picked = rand.choose(keys).unwrap();

        let signature = schema.get(picked).expect("requested api not in schema");
        let signature = signature.sample(rand).map_err(RailcarError::Unknown)?;

        let root = Node::api(
            0,
            picked.clone(),
            signature,
            rng::context_byte_seq(rand, None),
            0.0,
        );
        Ok(Graph::from_node(root, schema.clone()))
    }

    fn from_node(root: Node, schema: Schema) -> Self {
        let root_id = root.id;
        let mut nodes = BTreeMap::new();
        nodes.insert(root_id, root);
        Self {
            schema,
            root: root_id,
            nodes,
        }
    }

    pub fn create<R: Rand>(rand: &mut R, schema: &Schema) -> Result<Self, RailcarError> {
        let mut graph = Self::seed(rand, schema)?;
        graph.complete(rand)?;
        Ok(graph)
    }

    /// Create a new graph, but as a single endpoint with constant inputs
    pub fn create_small<R: Rand>(rand: &mut R, schema: &Schema) -> Result<Self, RailcarError> {
        let mut graph = Self::seed(rand, schema)?;
        graph.limited_complete(rand, MAX_COMPLETION_ITER, 0)?;
        Ok(graph)
    }

    fn visit_undirected<F>(&self, node: &Node, func: &F, visited: &mut HashSet<NodeId>)
    where
        F: Fn(&Node),
    {
        if visited.contains(&node.id) {
            return;
        }

        func(node);
        visited.insert(node.id);

        for out in &node.outgoing {
            let next = self.nodes.get(&out.dst).unwrap();
            self.visit_undirected(next, func, visited);
        }

        for inc in &node.incoming {
            let next = self.nodes.get(&inc.src).unwrap();
            self.visit_undirected(next, func, visited);
        }
    }

    pub fn cleanup(&mut self) {
        // mark ...

        let mut visited = HashSet::new();
        let root = self.nodes.get(&self.root).unwrap();
        self.visit_undirected(root, &noop, &mut visited);

        let to_remove: HashSet<_> = self
            .nodes
            .keys()
            .filter(|id| !visited.contains(id))
            .cloned()
            .collect();

        // sweep ...

        for id in &to_remove {
            self.nodes.remove(id);
        }

        // cleanup dangling edges ...

        // cannot iterate over self.nodes directly because it is mutated in the loop body
        let keys: Vec<NodeId> = self.nodes.keys().cloned().collect();
        for node_id in keys {
            let node = self.nodes.get_mut(&node_id).unwrap();
            node.incoming = node
                .incoming
                .iter()
                .filter(|inc| !to_remove.contains(&inc.src))
                .cloned()
                .collect();
            node.outgoing = node
                .outgoing
                .iter()
                .filter(|out| !to_remove.contains(&out.dst))
                .cloned()
                .collect();
        }
    }

    pub fn complete<R: Rand>(&mut self, rand: &mut R) -> Result<(), RailcarError> {
        self.limited_complete(rand, MAX_COMPLETION_ITER, MAX_COMPLETE_WITH_ENDPOINTS)
    }

    fn limited_complete<R: Rand>(
        &mut self,
        rand: &mut R,
        max_completion_iter: usize,
        max_complete_with_endpoints: usize,
    ) -> Result<(), RailcarError> {
        let mut remaining: VecDeque<NodeId> = self
            .nodes
            .values()
            .filter(|node| !node.is_fulfilled())
            .map(|node| node.id)
            .collect();

        let mut type_to_node_ids = self.get_node_types();

        let mut it = 0;
        while let Some(id) = remaining.pop_front() {
            let node = self.nodes.get(&id).ok_or(RailcarError::Unknown(anyhow!(
                "node with id {id} not in graph"
            )))?;

            debug_assert!(!node.is_fulfilled());

            let use_endpoints = it < max_complete_with_endpoints;

            self.fill_node(
                rand,
                &id,
                &mut remaining,
                use_endpoints,
                &mut type_to_node_ids,
            )
            .map_err(RailcarError::Unknown)?;

            it += 1;
            if it > max_completion_iter {
                return Err(RailcarError::HugeGraph);
            }
        }

        self.reroot();

        Ok(())
    }

    fn reroot(&mut self) {
        let mut root = self.nodes.get(&self.root).unwrap();
        while !root.incoming.is_empty() {
            root = self.nodes.get(&root.incoming[0].src).unwrap();
        }
        self.root = root.id;
    }

    fn fill_node<R: Rand>(
        &mut self,
        rand: &mut R,
        id: &NodeId,
        remaining: &mut VecDeque<NodeId>,
        use_endpoints: bool,
        type_to_node_ids: &mut TypeToNodeIds,
    ) -> Result<()> {
        let (filled, signature, context) = {
            let node = self
                .nodes
                .get(id)
                .ok_or(anyhow!("node with id {id} not in graph"))?;

            // constants don't need filling
            let NodePayload::Api {
                signature, context, ..
            } = &node.payload
            else {
                return Ok(());
            };

            // Need to drop all references to self so that we can mutate it later
            let signature = signature.clone();
            let filled = node.get_filled_ports();

            (filled, signature, context)
        };

        let mut context_rand = rng::BytesRand::new(context);
        for (port, arg) in signature.args.iter().enumerate() {
            if filled.contains(&port) {
                continue;
            }

            let reuse_node = rand.coinflip(FILL_REUSE_RATE);
            if reuse_node {
                if let Some(ids) = type_to_node_ids.get(arg) {
                    let dst = self.nodes.get(id).unwrap();
                    let deeper: Vec<usize> = ids
                        .iter()
                        .filter_map(|id| {
                            let src = self.nodes.get(id).unwrap();
                            if src.depth > dst.depth {
                                Some(src.id)
                            } else {
                                None
                            }
                        })
                        .collect();
                    if !deeper.is_empty() {
                        let src = rand.choose(deeper).unwrap();
                        self.connect(src, dst.id, port, dst.next_eval_order());
                        continue;
                    }
                }
            }

            let new_id = self.next_node_id();
            let use_api = use_endpoints && rand.coinflip(1.0 - FILL_CONSTANT_RATE);
            let new_depth = self.nodes.get(id).unwrap().depth + 1.0;

            let new = if let Type::Class(cls) = arg {
                // classes always need construction
                let Some((name, sig, _)) = self.schema.concretize(
                    rand,
                    SignatureQuery {
                        args: None,
                        ret: Some(arg.clone()),
                        // if we're closing out the graph, just use the constructor
                        callconv: if use_api {
                            None
                        } else {
                            Some(CallConvention::Constructor)
                        },
                    },
                ) else {
                    panic!("cannot find an API to generate class {}", cls);
                };
                Node::api(
                    new_id,
                    name,
                    sig,
                    rng::context_byte_seq(rand, None),
                    new_depth,
                )
            } else if use_api {
                if let Some((name, sig, _)) = self.schema.concretize(
                    rand,
                    SignatureQuery {
                        args: None,
                        ret: Some(arg.clone()),
                        callconv: None,
                    },
                ) {
                    Node::api(
                        new_id,
                        name,
                        sig,
                        rng::context_byte_seq(rand, None),
                        new_depth,
                    )
                } else {
                    Node::constant(
                        new_id,
                        arg.clone(),
                        arg.sample(&mut context_rand)?,
                        new_depth,
                    )
                }
            } else {
                Node::constant(
                    new_id,
                    arg.clone(),
                    arg.sample(&mut context_rand)?,
                    new_depth,
                )
            };

            // mutations ...
            {
                if !new.is_fulfilled() {
                    remaining.push_back(new_id);
                }
                insert_or_append(type_to_node_ids, arg, new_id);
                self.nodes.insert(new_id, new);
                let node = self.nodes.get(id).unwrap();
                self.connect(new_id, node.id, port, node.next_eval_order());
            }
        }

        Ok(())
    }

    pub fn next_node_id(&self) -> NodeId {
        if let Some(max) = self.nodes.keys().max() {
            max + 1
        } else {
            0
        }
    }

    pub fn get_type(&self, id: &NodeId) -> &Type {
        let node = self.nodes.get(id).expect("node id not in graph");
        node.get_type()
    }

    pub fn disconnect(&mut self, src_id: NodeId, dst_id: NodeId) {
        let from = self.nodes.get_mut(&src_id).unwrap();
        let out_edge_idx = from
            .outgoing
            .iter()
            .enumerate()
            .find(|(_, out)| out.dst == dst_id)
            .map(|(idx, _)| idx)
            .unwrap();
        from.outgoing.swap_remove(out_edge_idx);

        let to = self.nodes.get_mut(&dst_id).unwrap();
        let in_edge_idx = to
            .incoming
            .iter()
            .enumerate()
            .find(|(_, out)| out.src == src_id)
            .map(|(idx, _)| idx)
            .unwrap();
        to.incoming.swap_remove(in_edge_idx);
    }

    pub fn connect(&mut self, src: NodeId, dst: NodeId, port: usize, evaluation_order: usize) {
        assert!(self.nodes.contains_key(&src));
        assert!(self.nodes.contains_key(&dst));
        assert!({
            let from = self.nodes.get(&src).unwrap();
            let to = self.nodes.get(&dst).unwrap();
            from.depth > to.depth
        });

        let from = self.nodes.get_mut(&src).unwrap();
        from.outgoing.push(OutgoingEdge { dst });

        let to = self.nodes.get_mut(&dst).unwrap();
        to.incoming.push(IncomingEdge {
            src,
            port,
            evaluation_order,
        });
    }

    pub fn set_max_depth(&mut self, depth: f64) {
        let offset = depth - self.max_depth();
        for node in self.nodes.values_mut() {
            node.depth += offset;
        }
    }

    pub fn max_depth(&self) -> f64 {
        self.nodes
            .values()
            .max_by(|x, y| x.depth.total_cmp(&y.depth))
            .map(|n| n.depth)
            .unwrap_or(0.0)
    }

    pub fn min_depth(&self) -> f64 {
        self.nodes
            .values()
            .min_by(|x, y| x.depth.total_cmp(&y.depth))
            .map(|n| n.depth)
            .unwrap_or(0.0)
    }

    pub fn offset_ids(&mut self, by: NodeId) {
        let mut nodes = BTreeMap::new();
        for node in self.nodes.values() {
            let mut node = node.clone();
            node.id += by;
            for inc in node.incoming.iter_mut() {
                inc.src += by;
            }
            for out in node.outgoing.iter_mut() {
                out.dst += by;
            }
            nodes.insert(node.id, node);
        }
        self.root += by;
        self.nodes = nodes;
    }
}

impl From<RailcarError> for libafl::Error {
    fn from(value: RailcarError) -> Self {
        match value {
            RailcarError::Unknown(msg) => libafl::Error::unknown(format!("{}", msg)),
            RailcarError::HugeGraph => libafl::Error::illegal_state("graph too big"),
        }
    }
}

impl Display for Graph {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Graph {{")?;
        writeln!(f, "  root: {},", self.root)?;
        writeln!(f, "  nodes:")?;
        for node in self.nodes.values() {
            writeln!(f, "  - {:?}", node)?;
        }
        write!(f, "}}")
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ParametricGraph {
    schema: Schema,

    #[serde(with = "serde_bytes")]
    bytes: Vec<u8>,
}

impl ParametricGraph {
    pub fn new(schema: Schema, bytes: Vec<u8>) -> Self {
        Self { schema, bytes }
    }
}

impl Hash for ParametricGraph {
    fn hash<H: Hasher>(&self, state: &mut H) {
        #[expect(clippy::disallowed_methods)]
        let ser = rmp_serde::to_vec(self).expect("failed to serialize graph for hash");
        ser.hash(state);
    }
}

impl Input for ParametricGraph {
    fn to_file<P>(&self, path: P) -> Result<(), libafl::Error>
    where
        P: AsRef<std::path::Path>,
    {
        let serialized = rmp_serde::to_vec_named(self)
            .map_err(|e| libafl::Error::unknown(format!("failed to serialize input {}", e)))?;
        assert!(
            serialized.len() < DEFAULT_MAX_SIZE,
            "graph exceeds state max size"
        );
        libafl_bolts::fs::write_file_atomic(path, &serialized)
    }

    fn from_file<P>(path: P) -> Result<Self, libafl::Error>
    where
        P: AsRef<std::path::Path>,
    {
        let file = std::fs::File::open(path)?;
        let deserialized = rmp_serde::from_read(file)
            .map_err(|e| libafl::Error::unknown(format!("failed to load input {}", e)))?;
        Ok(deserialized)
    }
}

impl HasSchema for ParametricGraph {
    fn schema(&self) -> &Schema {
        &self.schema
    }

    fn schema_mut(&mut self) -> &mut Schema {
        &mut self.schema
    }
}

impl HasMutatorBytes for ParametricGraph {
    fn mutator_bytes(&self) -> &[u8] {
        &self.bytes
    }

    fn mutator_bytes_mut(&mut self) -> &mut [u8] {
        &mut self.bytes
    }
}

impl HasLen for ParametricGraph {
    fn len(&self) -> usize {
        self.bytes.len()
    }
}

impl ResizableMutator<u8> for ParametricGraph {
    fn resize(&mut self, new_len: usize, value: u8) {
        self.bytes.resize(new_len, value);
    }

    fn extend<'a, I: IntoIterator<Item = &'a u8>>(&mut self, iter: I) {
        Extend::extend(&mut self.bytes, iter);
    }

    fn splice<R, I>(&mut self, range: R, replace_with: I) -> std::vec::Splice<'_, I::IntoIter>
    where
        R: core::ops::RangeBounds<usize>,
        I: IntoIterator<Item = u8>,
    {
        self.bytes.splice(range, replace_with)
    }

    fn drain<R>(&mut self, range: R) -> std::vec::Drain<'_, u8>
    where
        R: core::ops::RangeBounds<usize>,
    {
        self.bytes.drain(range)
    }
}

impl CanValidate for Graph {
    fn is_valid(&self) {
        assert!(self.nodes.contains_key(&self.root));
        let root = self.nodes.get(&self.root).unwrap();
        assert!(root.incoming.is_empty());

        for node in self.nodes.values() {
            let mut ports = HashSet::new();
            for inc in &node.incoming {
                assert!(self.nodes.contains_key(&inc.src));
                assert!(
                    !ports.contains(&inc.port),
                    "multiple incoming edges for same port"
                );
                ports.insert(inc.port);
            }

            for out in &node.outgoing {
                assert!(self.nodes.contains_key(&out.dst));
            }
        }
    }
}

impl CanValidate for ParametricGraph {}

impl HasSeqLen for BytesInput {
    fn seq_len(&self) -> usize {
        1
    }
}

impl HasSeqLen for ParametricGraph {
    fn seq_len(&self) -> usize {
        1
    }
}
