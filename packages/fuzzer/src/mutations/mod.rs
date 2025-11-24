#![allow(dead_code)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
    borrow::Cow,
    collections::{BTreeMap, HashSet},
    num::NonZero,
};

use libafl::{
    corpus::{Corpus, CorpusId},
    inputs::Input,
    mutators::{
        havoc_mutations, havoc_mutations_no_crossover, HavocMutationsType, HavocScheduledMutator,
        MutationResult as LibAflMutationResult, Mutator, MutatorsTuple,
    },
    random_corpus_id_with_disabled,
    state::{HasCorpus, HasMaxSize, HasRand},
};

use libafl_bolts::{
    rands::Rand,
    tuples::{tuple_list, tuple_list_type},
    HasLen, Named,
};

use crate::{
    inputs::{
        graph::{IncomingEdge, Node, NodeId, NodePayload, OutgoingEdge, RailcarError},
        ApiSeq, CanValidate, Graph, HasSeqLen,
    },
    rng::{
        context_byte_seq, extend_context_byte_seq, redistribute, string, BytesRand, Distribution,
        TrySample,
    },
    schema::{
        CallConvention, EndpointName, HasSchema, Schema, Signature, SignatureGuess, SignatureQuery,
        Type, TypeGuess, TypeKind,
    },
};

use crate::config::{
    MAX_CONTEXT_MUTATION_ITERATIONS_LOG2, MAX_SCHEMA_MUTATION_ARGC,
    MAX_SCHEMA_MUTATION_TYPE_GUESS_CLASSES_COUNT, MAX_SCHEMA_MUTATION_TYPE_GUESS_PROPERTIES_COUNT,
    MUTATE_SCHEMA_ARGC_FILL_WITH_ANY, MUTATE_SCHEMA_CREATE_ANY_GUESS_RATE,
    MUTATE_SCHEMA_PRESERVE_CLASS_STRUCTURE,
};

macro_rules! mutation {
    ($x:ident) => {
        pub struct $x {}

        impl $x {
            pub fn new() -> Self {
                Self {}
            }
        }

        impl Default for $x {
            fn default() -> Self {
                Self::new()
            }
        }

        impl Named for $x {
            fn name(&self) -> &Cow<'static, str> {
                static NAME: Cow<'static, str> = Cow::Borrowed(stringify!($x));
                &NAME
            }
        }

        impl<S, I> Mutator<I, S> for $x
        where
            $x: ReversibleMutator<S, I>,
            I: Input + CanValidate,
        {
            fn mutate(
                &mut self,
                state: &mut S,
                input: &mut I,
            ) -> Result<LibAflMutationResult, libafl::Error> {
                let clone = input.clone();
                #[cfg(debug_assertions)]
                {
                    log::debug!("Applying {} to {}", self.name(), input.generate_name(None));
                }
                self.perform(state, input).map(|result| match result {
                    MutationResult::Undo => {
                        *input = clone;
                        LibAflMutationResult::Skipped
                    }
                    MutationResult::Skipped => LibAflMutationResult::Skipped,
                    MutationResult::Mutated => {
                        #[cfg(debug_assertions)]
                        {
                            log::debug!("  result: {}", input.generate_name(None));
                            input.is_valid();
                        }
                        LibAflMutationResult::Mutated
                    }
                })
            }

            fn post_exec(
                &mut self,
                _state: &mut S,
                _new_corpus_id: Option<CorpusId>,
            ) -> Result<(), libafl::Error> {
                Ok(())
            }
        }
    };
}

mutation!(Truncate);
mutation!(Extend);

mutation!(SpliceIn);
mutation!(SpliceOut);
mutation!(Crossover);
mutation!(Context);
mutation!(Swap);
mutation!(Priority);
mutation!(TruncateDestructor);
mutation!(ExtendDestructor);
mutation!(TruncateConstructor);
mutation!(ExtendConstructor);

mutation!(SchemaVariationArgc);
mutation!(SchemaVariationWeights);
mutation!(SchemaVariationMakeNullable);

/// There are some errors that would like to ignore (like a graph that's too large). But if these
/// happen after part of the input has been mutated we need to restore the input to the original
/// state.
trait ReversibleMutator<S, I: Input> {
    fn perform(&mut self, state: &mut S, input: &mut I) -> Result<MutationResult, libafl::Error>;
}

pub type SimpleGraphMutationsType = tuple_list_type!(Truncate, Extend,);

pub type ComplexGraphMutationsType = tuple_list_type!(
    SpliceIn,
    SpliceOut,
    Crossover,
    Context,
    Swap,
    Priority,
    TruncateDestructor,
    ExtendDestructor,
    TruncateConstructor,
    ExtendConstructor,
);

type FuzzSeqConsts = HavocScheduledMutator<HavocMutationsType>;

pub type SequenceMutationsType<'a> =
    tuple_list_type!(SpliceSeq<'a>, ExtendSeq<'a>, TruncateSeq, FuzzSeqConsts);

pub type ParametricMutationsType = HavocMutationsType;

pub struct GraphMutator<S> {
    inner: Box<dyn Mutator<Graph, S>>,
}

impl<S> GraphMutator<S>
where
    S: HasRand + HasCorpus<Graph> + HasMaxSize,
{
    pub fn new(simple: bool) -> Self {
        if simple {
            Self {
                inner: Box::new(HavocScheduledMutator::new(simple_graph_mutations())),
            }
        } else {
            Self {
                inner: Box::new(HavocScheduledMutator::new(complex_graph_mutations())),
            }
        }
    }
}

impl<S> Mutator<Graph, S> for GraphMutator<S>
where
    S: HasRand,
{
    #[inline]
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<LibAflMutationResult, libafl::Error> {
        self.inner.mutate(state, input)
    }

    #[inline]
    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<libafl::corpus::CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

impl<S> Named for GraphMutator<S> {
    fn name(&self) -> &Cow<'static, str> {
        self.inner.name()
    }
}

fn complex_graph_mutations() -> ComplexGraphMutationsType {
    tuple_list!(
        SpliceIn::new(),
        SpliceOut::new(),
        Crossover::new(),
        Context::new(),
        Swap::new(),
        Priority::new(),
        TruncateDestructor::new(),
        ExtendDestructor::new(),
        TruncateConstructor::new(),
        ExtendConstructor::new(),
    )
}

fn simple_graph_mutations() -> SimpleGraphMutationsType {
    tuple_list!(Truncate::new(), Extend::new(),)
}

pub fn parametric_mutations() -> ParametricMutationsType {
    havoc_mutations()
}

pub fn sequence_mutations<'a>(schema: &'a Schema) -> SequenceMutationsType<'a> {
    tuple_list!(
        SpliceSeq { schema },
        ExtendSeq { schema },
        TruncateSeq {},
        HavocScheduledMutator::new(havoc_mutations()),
    )
}

impl Truncate {
    fn pick<R: Rand>(&self, rand: &mut R, graph: &Graph) -> Option<(NodeId, usize)> {
        let nodes: Vec<&Node> = graph
            .nodes
            .values()
            .filter(|node| !node.outgoing.is_empty())
            .collect();
        if nodes.is_empty() {
            return None;
        }

        let node = rand.choose(nodes)?;
        let out_idx = rand.below(NonZero::new(node.outgoing.len()).unwrap());
        let node_id = node.id;

        Some((node_id, out_idx))
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for Truncate {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((src_id, out_idx)) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let src = input.nodes.get(&src_id).unwrap();
        let dst_id = src.outgoing[out_idx].dst;

        input.disconnect(src_id, dst_id);

        complete_and_cleanup(state.rand_mut(), input, src_id)
    }
}

impl Extend {
    fn pick<R: Rand>(&self, rand: &mut R, graph: &Graph) -> Option<NodeId> {
        let nodes: Vec<NodeId> = graph
            .nodes
            .values()
            .filter_map(|node| {
                if !matches!(node.get_type(), Type::Undefined) {
                    Some(node.id)
                } else {
                    None
                }
            })
            .collect();

        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes)?)
        }
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for Extend {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some(id) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let node = input.nodes.get(&id).unwrap();
        let typ = node.get_type();

        let Some((name, sig, _)) = input.schema().concretize(
            state.rand_mut(),
            SignatureQuery {
                args: Some(vec![typ.clone()]),
                ret: None,
                callconv: None,
            },
        ) else {
            return Ok(MutationResult::Skipped);
        };

        let Some(port) = sig.find_port(typ) else {
            return Err(libafl::Error::illegal_state(format!(
                "signature concretized for extend must accept type {:?}",
                typ
            )));
        };

        let new_id = input.next_node_id();
        let new = Node::api(
            new_id,
            name,
            sig,
            context_byte_seq(state.rand_mut(), None),
            node.depth - 1.0,
        );

        {
            input.nodes.insert(new_id, new);
            input.connect(id, new_id, port, 0);
        }

        complete(state.rand_mut(), input)
    }
}

impl SpliceIn {
    fn pick<R: Rand>(
        &self,
        rand: &mut R,
        graph: &Graph,
    ) -> Option<(NodeId, EndpointName, Signature, Vec<usize>)> {
        let nodes: Vec<_> = graph
            .nodes
            .values()
            .filter_map(|node| {
                if node.outgoing.is_empty() {
                    return None;
                };

                let typ = node.get_type();
                graph
                    .schema()
                    .concretize(
                        rand,
                        SignatureQuery {
                            args: Some(vec![typ.clone()]),
                            ret: Some(typ.clone()),
                            callconv: None,
                        },
                    )
                    .map(|(name, sig, ports)| (node.id, name, sig, ports.unwrap()))
            })
            .collect();

        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes)?)
        }
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for SpliceIn {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((from_id, name, sig, ports)) = self.pick(state.rand_mut(), input) else {
            // did not find an edge to splice in
            return Ok(MutationResult::Skipped);
        };

        let from = input.nodes.get(&from_id).unwrap();
        let from_depth = from.depth;

        let edge = state
            .rand_mut()
            .choose(&from.outgoing)
            .ok_or(libafl::Error::illegal_state(
                "no outgoing edges for SpliceIn",
            ))?;

        let to_id = edge.dst;
        let to = input.nodes.get(&to_id).unwrap();
        let to_depth = to.depth;
        let to_inc = to.incoming.iter().find(|inc| inc.src == from_id).unwrap();
        let to_port = to_inc.port;
        let to_eval_order = to_inc.evaluation_order;

        let new_id = input.next_node_id();

        assert!(
            ports.len() == 1,
            "SpliceIn should be concretized with 1 argument in query"
        );
        let port = ports[0];

        let new_depth = (from_depth + to_depth) / 2.0;
        let new = Node::api(
            new_id,
            name,
            sig,
            context_byte_seq(state.rand_mut(), None),
            new_depth,
        );

        // mutations start now ...
        {
            input.nodes.insert(new_id, new);
            input.disconnect(from_id, to_id);
            input.connect(from_id, new_id, port, 0);
            input.connect(new_id, to_id, to_port, to_eval_order);
        }

        complete(state.rand_mut(), input)
    }
}

enum MutationResult {
    Mutated,
    Skipped,
    Undo,
}

fn complete_and_cleanup<R: Rand>(
    rand: &mut R,
    graph: &mut Graph,
    root: NodeId,
) -> Result<MutationResult, libafl::Error> {
    graph.root = root;
    if let Err(e) = graph.complete(rand) {
        if let RailcarError::HugeGraph = e {
            return Ok(MutationResult::Undo);
        } else {
            return Err(e.into());
        }
    }
    graph.cleanup();
    Ok(MutationResult::Mutated)
}

fn complete<R: Rand>(rand: &mut R, graph: &mut Graph) -> Result<MutationResult, libafl::Error> {
    match graph.complete(rand) {
        Ok(_) => Ok(MutationResult::Mutated),
        Err(e) => match e {
            RailcarError::HugeGraph => Ok(MutationResult::Undo),
            RailcarError::Unknown(msg) => Err(libafl::Error::unknown(format!("{}", msg))),
        },
    }
}

impl SpliceOut {
    fn pick<R: Rand>(rand: &mut R, graph: &Graph) -> Option<(NodeId, usize, usize)> {
        let nodes: Vec<_> = graph
            .nodes
            .values()
            .filter(|n| !n.incoming.is_empty() && !n.outgoing.is_empty())
            .collect();

        if nodes.is_empty() {
            return None;
        }

        let mut with_same_type = Vec::new();
        for node in nodes {
            let out_typ = node.get_type();
            for (inc_idx, inc) in node.incoming.iter().enumerate() {
                let inc_typ = graph.get_type(&inc.src);
                if inc_typ == out_typ {
                    let out_idx = rand.below(NonZero::new(node.outgoing.len()).unwrap());
                    with_same_type.push((node.id, inc_idx, out_idx));
                }
            }
        }

        if with_same_type.is_empty() {
            None
        } else {
            Some(rand.choose(with_same_type)?)
        }
    }
}

impl<S> ReversibleMutator<S, Graph> for SpliceOut
where
    S: HasRand,
{
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((node_id, inc_idx, out_idx)) = SpliceOut::pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let node = input.nodes.get(&node_id).unwrap();

        let inc_edge = node.incoming.get(inc_idx).unwrap();
        let from_id = inc_edge.src;

        let out_edge = node.outgoing.get(out_idx).unwrap();
        let to_id = out_edge.dst;

        {
            let from = input.nodes.get_mut(&from_id).unwrap();
            let edge = from.outgoing.iter_mut().find(|e| e.dst == node_id).unwrap();
            edge.dst = to_id;
        }

        {
            let to = input.nodes.get_mut(&to_id).unwrap();
            let edge = to.incoming.iter_mut().find(|e| e.src == node_id).unwrap();
            edge.src = from_id;
        }

        complete_and_cleanup(state.rand_mut(), input, from_id)
    }
}

impl Crossover {
    fn pick<R: Rand>(
        &self,
        rand: &mut R,
        input: &Graph,
        other: &Graph,
    ) -> Option<((NodeId, usize), (NodeId, usize))> {
        let mut nodes: Vec<((NodeId, usize), (NodeId, usize))> = Vec::new();
        for in_node in input.nodes.values() {
            // TODO: do we want to include nodes that don't have any outgoing ones?
            if in_node.outgoing.is_empty() {
                continue;
            }

            for other_node in other.nodes.values() {
                let NodePayload::Api { signature, .. } = &other_node.payload else {
                    continue;
                };

                let typ = in_node.get_type();

                let Some(port) = signature
                    .args
                    .iter()
                    .enumerate()
                    .find(|(_, arg)| *arg == typ)
                    .map(|(port, _)| port)
                else {
                    continue;
                };

                let inc_idx = other_node
                    .incoming
                    .iter()
                    .enumerate()
                    .find(|(_, inc)| inc.port == port)
                    .map(|(idx, _)| idx)
                    .unwrap();
                let out_idx = rand.between(0, in_node.outgoing.len() - 1);

                nodes.push(((in_node.id, out_idx), (other_node.id, inc_idx)));
            }
        }

        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes)?)
        }
    }
}

impl<S> ReversibleMutator<S, Graph> for Crossover
where
    S: HasCorpus<Graph> + HasRand,
{
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let mut other = {
            let id = random_corpus_id_with_disabled!(state.corpus(), state.rand_mut());
            let mut other_testcase = state.corpus().get_from_all(id)?.borrow_mut();
            let other = other_testcase.load_input(state.corpus())?;
            other.clone()
        };

        let Some(((src, out_edge_idx), (dst, in_edge_idx))) =
            self.pick(state.rand_mut(), input, &other)
        else {
            return Ok(MutationResult::Skipped);
        };

        let offset = input.next_node_id();
        let depth = input.min_depth();
        other.offset_ids(offset);
        other.set_max_depth(depth - 1.0);
        let dst = dst + offset;

        // disconnect outgoing
        {
            let from = input.nodes.get(&src).unwrap();
            let dst = from.outgoing[out_edge_idx].dst;
            input.disconnect(src, dst);
        }

        // disconnect incoming
        let (port, eval_order) = {
            let to = other.nodes.get(&dst).unwrap();
            let IncomingEdge {
                src,
                port,
                evaluation_order,
            } = to.incoming[in_edge_idx];
            other.disconnect(src, dst);
            (port, evaluation_order)
        };

        // merge the graphs
        {
            for (id, node) in other.nodes {
                input.nodes.insert(id, node);
            }
            input.connect(src, dst, port, eval_order);
            complete_and_cleanup(state.rand_mut(), input, src)
        }
    }
}

impl Context {
    /// Pick an API node that has incoming constants which can be meaningfully resampled
    fn pick<R: Rand>(&self, rand: &mut R, graph: &mut Graph) -> Option<NodeId> {
        let nodes: Vec<NodeId> = graph
            .nodes
            .iter()
            .filter(|(_, node)| {
                node.incoming.iter().any(|inc| {
                    let inc = graph.nodes.get(&inc.src).unwrap();
                    let NodePayload::Constant { typ, .. } = &inc.payload else {
                        return false;
                    };
                    !matches!(typ, Type::Null | Type::Undefined | Type::Class(_))
                })
            })
            .map(|(_, node)| node.id)
            .collect();
        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes).unwrap())
        }
    }

    // emulates a libafl::StdScheduledMutator
    fn mutate_bytes<S>(
        &self,
        state: &mut S,
        input: &mut Vec<u8>,
    ) -> Result<MutationResult, libafl::Error>
    where
        S: HasRand + HasMaxSize,
    {
        // these are stateless
        let mut mutations = havoc_mutations_no_crossover();

        let mut r = MutationResult::Skipped;
        let num = 1
            << (state
                .rand_mut()
                .between(1, MAX_CONTEXT_MUTATION_ITERATIONS_LOG2));
        for _ in 0..num {
            let idx = state
                .rand_mut()
                .below(unsafe { NonZero::new(mutations.len()).unwrap_unchecked() })
                .into();
            let outcome = mutations.get_and_mutate(idx, state, input)?;
            if outcome == LibAflMutationResult::Mutated {
                r = MutationResult::Mutated;
            }
        }

        Ok(r)
    }
}

impl<S> ReversibleMutator<S, Graph> for Context
where
    S: HasRand + HasMaxSize,
{
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some(id) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let new_context = {
            let node = input
                .nodes
                .get_mut(&id)
                .ok_or(libafl::Error::illegal_state(
                    "constant node id not found in graph",
                ))?;

            let NodePayload::Api { context, .. } = &mut node.payload else {
                return Err(libafl::Error::illegal_state(
                    "Context mutation invoked on constant node",
                ));
            };

            self.mutate_bytes(state, context)?;
            extend_context_byte_seq(state.rand_mut(), context, None);
            context.clone()
        };

        {
            let consts: HashSet<NodeId> = {
                let node = &input.nodes[&id];
                node.incoming
                    .iter()
                    .filter_map(|inc| {
                        let inc = &input.nodes[&inc.src];
                        let NodePayload::Constant { typ, .. } = &inc.payload else {
                            return None;
                        };

                        if !matches!(typ, Type::Null | Type::Undefined | Type::Class(_)) {
                            Some(inc.id)
                        } else {
                            None
                        }
                    })
                    .collect()
            };

            let mut const_rand = BytesRand::new(&new_context);
            for src in consts {
                let const_node = input.nodes.get_mut(&src).unwrap();
                let NodePayload::Constant { typ, value } = &mut const_node.payload else {
                    return Err(libafl::Error::illegal_state(
                        "Context mutation trying to resample API node",
                    ));
                };
                *value = typ.sample(&mut const_rand).map_err(RailcarError::Unknown)?;
            }
        }

        Ok(MutationResult::Mutated)
    }
}

impl Swap {
    fn pick<R: Rand>(
        &self,
        rand: &mut R,
        graph: &Graph,
    ) -> Option<(NodeId, EndpointName, Signature, Vec<usize>)> {
        let results: Vec<_> = graph
            .nodes
            .iter()
            .filter_map(|(id, node)| {
                let NodePayload::Api {
                    signature, name, ..
                } = &node.payload
                else {
                    return None;
                };
                let args = signature.args.clone();
                let ret = signature.ret.clone();
                let (conc_name, conc_sig, ports) = graph.schema().concretize(
                    rand,
                    SignatureQuery {
                        args: Some(args),
                        ret: Some(ret),
                        callconv: None,
                    },
                )?;

                if conc_name != *name {
                    Some((*id, conc_name, conc_sig, ports.unwrap()))
                } else {
                    None
                }
            })
            .collect();

        if results.is_empty() {
            None
        } else {
            Some(rand.choose(results).unwrap())
        }
    }
}

impl<S> ReversibleMutator<S, Graph> for Swap
where
    S: HasRand,
{
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((id, name, signature, ports)) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let node = input
            .nodes
            .get_mut(&id)
            .ok_or(libafl::Error::illegal_state("node id not in graph"))?;

        let NodePayload::Api { context, .. } = &node.payload else {
            return Err(libafl::Error::illegal_state(
                "picked node for swap is not an API node",
            ));
        };

        for inc in node.incoming.iter_mut() {
            inc.port = ports[inc.port];
        }

        node.payload = NodePayload::Api {
            name,
            signature,
            context: context.clone(),
        };

        complete(state.rand_mut(), input)
    }
}

impl Priority {
    fn pick<R: Rand>(&self, rand: &mut R, graph: &Graph) -> Option<NodeId> {
        let nodes: Vec<NodeId> = graph
            .nodes
            .iter()
            .filter(|(_, node)| node.incoming.len() >= 2 || node.outgoing.len() >= 2)
            .map(|(id, _)| *id)
            .collect();

        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes)?)
        }
    }
}

fn shuffle<R: Rand, T>(rand: &mut R, vec: &mut [T]) {
    for i in (1..vec.len()).rev() {
        let pick = rand.below(NonZero::new(i).unwrap());
        vec.swap(pick, i - 1);
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for Priority {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some(id) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let node = input
            .nodes
            .get_mut(&id)
            .ok_or(libafl::Error::illegal_state("node id not in graph"))?;

        if node.outgoing.len() >= 2 {
            shuffle(state.rand_mut(), &mut node.outgoing);
        }

        if node.incoming.len() >= 2 {
            let mut orders: Vec<usize> = node
                .incoming
                .iter()
                .map(|inc| inc.evaluation_order)
                .collect();
            shuffle(state.rand_mut(), &mut orders);

            for (idx, inc) in node.incoming.iter_mut().enumerate() {
                inc.evaluation_order = orders[idx];
            }
        }

        Ok(MutationResult::Mutated)
    }
}

impl TruncateDestructor {
    fn pick<R: Rand>(&self, rand: &mut R, graph: &Graph) -> Option<(NodeId, NodeId)> {
        let nodes: Vec<_> = graph
            .nodes
            .iter()
            .filter(|(_, node)| !node.outgoing.is_empty())
            .map(|(_, node)| node)
            .collect();
        if nodes.is_empty() {
            None
        } else {
            let node = rand.choose(nodes)?;
            let edge = rand.choose(&node.outgoing)?;
            Some((node.id, edge.dst))
        }
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for TruncateDestructor {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((src_id, dst_id)) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        input.disconnect(src_id, dst_id);

        // in case the root was in the removed sub-graph
        complete_and_cleanup(state.rand_mut(), input, src_id)
    }
}

impl ExtendDestructor {
    fn pick<R: Rand>(
        &self,
        rand: &mut R,
        graph: &Graph,
    ) -> Option<(NodeId, EndpointName, Signature, Vec<usize>)> {
        let nodes: Vec<_> = graph
            .nodes
            .values()
            .filter_map(|node| {
                if !node.outgoing.is_empty() {
                    return None;
                }

                if let NodePayload::Api { signature, .. } = &node.payload {
                    if let Type::Undefined = signature.ret {
                        return None;
                    }
                }

                let typ = node.get_type().clone();
                graph
                    .schema()
                    .concretize(
                        rand,
                        SignatureQuery {
                            args: Some(vec![typ]),
                            ret: None,
                            callconv: None,
                        },
                    )
                    .map(|(name, sig, ports)| (node.id, name, sig, ports.unwrap()))
            })
            .collect();

        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes)?)
        }
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for ExtendDestructor {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((id, name, sig, ports)) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        assert!(
            ports.len() == 1,
            "ExtendDestructor should be concretized with 1 argument"
        );
        let port = ports[0];

        let next_id = input.next_node_id();
        let new_depth = input.nodes.get(&id).unwrap().depth - 1.0;

        let mut new = Node::api(
            next_id,
            name,
            sig,
            context_byte_seq(state.rand_mut(), None),
            new_depth,
        );
        new.incoming.push(IncomingEdge {
            src: id,
            evaluation_order: 0,
            port,
        });

        // mutations ...

        {
            let node = input.nodes.get_mut(&id).unwrap();
            node.outgoing.push(OutgoingEdge { dst: next_id });
            input.nodes.insert(next_id, new);
        }

        complete(state.rand_mut(), input)
    }
}

impl TruncateConstructor {
    fn pick<R: Rand>(&self, rand: &mut R, graph: &Graph) -> Option<(NodeId, NodeId)> {
        let nodes: Vec<_> = graph
            .nodes
            .values()
            .filter(|node| !node.incoming.is_empty())
            .collect();

        if nodes.is_empty() {
            return None;
        }

        let node = rand.choose(nodes)?;
        let inc = rand.choose(&node.incoming)?;

        Some((inc.src, node.id))
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for TruncateConstructor {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((src_id, dst_id)) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        input.disconnect(src_id, dst_id);

        complete_and_cleanup(state.rand_mut(), input, dst_id)
    }
}

impl ExtendConstructor {
    fn pick<R: Rand>(
        &self,
        rand: &mut R,
        graph: &Graph,
    ) -> Option<(NodeId, EndpointName, Signature)> {
        let nodes: Vec<_> = graph
            .nodes
            .values()
            .filter_map(|node| {
                if !node.incoming.is_empty() {
                    return None;
                }

                let typ = node.get_type().clone();
                graph
                    .schema()
                    .concretize(
                        rand,
                        SignatureQuery {
                            args: None,
                            ret: Some(typ),
                            callconv: None,
                        },
                    )
                    .map(|(name, sig, _)| (node.id, name, sig))
            })
            .collect();
        if nodes.is_empty() {
            None
        } else {
            Some(rand.choose(nodes)?)
        }
    }
}

impl<S: HasRand> ReversibleMutator<S, Graph> for ExtendConstructor {
    fn perform(
        &mut self,
        state: &mut S,
        input: &mut Graph,
    ) -> Result<MutationResult, libafl::Error> {
        let Some((id, name, sig)) = self.pick(state.rand_mut(), input) else {
            return Ok(MutationResult::Skipped);
        };

        let constr = input.nodes.get(&id).unwrap();

        let mut new = Node::api(
            id,
            name,
            sig,
            context_byte_seq(state.rand_mut(), None),
            constr.depth,
        );
        new.outgoing = constr.outgoing.clone();

        input
            .nodes
            .insert(id, new)
            .ok_or(libafl::Error::illegal_state(
                "node to be replaced does not exist in graph",
            ))?;

        complete(state.rand_mut(), input)
    }
}

pub fn subset<T, R>(rand: &mut R, set: &[T], num: usize) -> Vec<T>
where
    T: Clone,
    R: Rand,
{
    let mut values = set.to_vec();

    if num > set.len() {
        return values;
    }

    let mut sub = Vec::new();
    for _ in 0..num {
        let idx = rand.between(0, values.len() - 1);
        sub.push(values.swap_remove(idx));
    }

    sub
}

fn generate_distribution<R, K>(rand: &mut R, keys: &[K]) -> Distribution<K>
where
    R: Rand,
    K: std::hash::Hash + Eq + Clone,
{
    let mut map = Distribution::new();
    for key in keys {
        map.insert(key.clone(), 0.0);
    }
    redistribute(rand, &mut map);
    map
}

fn apply_schema_mutation<R, F, I>(
    rand: &mut R,
    input: &mut I,
    mutate: F,
) -> Result<MutationResult, libafl::Error>
where
    R: Rand,
    F: Fn(&mut R, &mut SignatureGuess) -> Result<MutationResult, libafl::Error>,
    I: HasSchema,
{
    let endpoints: Vec<String> = input.schema().keys().cloned().collect();
    if endpoints.is_empty() {
        return Ok(MutationResult::Skipped);
    }

    let endpoint = rand
        .choose(&endpoints)
        .ok_or(libafl::Error::unknown("no valid endpoints"))?;
    let Some(guess) = input.schema_mut().get_mut(endpoint) else {
        return Err(libafl::Error::key_not_found(format!(
            "endpoint not found in schema {}",
            endpoint
        )));
    };

    let result = mutate(rand, guess)?;

    Ok(result)
}

impl SchemaVariationArgc {
    fn mutate_argc<R: Rand>(
        rand: &mut R,
        guess: &mut SignatureGuess,
        classes: &[EndpointName],
    ) -> Result<MutationResult, libafl::Error> {
        let lower = if matches!(guess.callconv, CallConvention::Method)
            && MUTATE_SCHEMA_PRESERVE_CLASS_STRUCTURE
        {
            1
        } else {
            0
        };
        let upper = MAX_SCHEMA_MUTATION_ARGC;

        guess.args.resize_with(rand.between(lower, upper), || {
            if MUTATE_SCHEMA_ARGC_FILL_WITH_ANY {
                TypeGuess::any()
            } else {
                Self::create_type_guess(rand, classes)
            }
        });

        Ok(MutationResult::Mutated)
    }

    fn create_type_guess<R: Rand>(rand: &mut R, classes: &[EndpointName]) -> TypeGuess {
        if rand.next_float() < MUTATE_SCHEMA_CREATE_ANY_GUESS_RATE {
            return TypeGuess::any();
        }

        let mut guess = TypeGuess {
            kind: generate_distribution(rand, &TypeKind::kinds()),
            ..Default::default()
        };

        if guess.kind[&TypeKind::Class] > 0.0 {
            let nr_classes = rand.between(1, MAX_SCHEMA_MUTATION_TYPE_GUESS_CLASSES_COUNT.into());
            let keys = subset(rand, classes, nr_classes);
            guess.class_type = Some(generate_distribution(rand, &keys));
        }

        if guess.kind[&TypeKind::Object] > 0.0 {
            let nr_properties = rand.below(MAX_SCHEMA_MUTATION_TYPE_GUESS_PROPERTIES_COUNT);
            let mut properties = BTreeMap::new();
            for _ in 0..nr_properties {
                let prop = string(rand);
                properties.insert(prop, Self::create_type_guess(rand, classes));
            }
            guess.object_shape = Some(properties);
        }

        if guess.kind[&TypeKind::Array] > 0.0 {
            guess.array_value_type = Some(Box::new(Self::create_type_guess(rand, classes)));
        }

        guess
    }
}

impl<S, I> ReversibleMutator<S, I> for SchemaVariationArgc
where
    S: HasRand,
    I: HasSchema + Input,
{
    fn perform(&mut self, state: &mut S, input: &mut I) -> Result<MutationResult, libafl::Error> {
        let classes = input.schema().classes();
        apply_schema_mutation(state.rand_mut(), input, |rand, guess| {
            Self::mutate_argc(rand, guess, &classes)
        })
    }
}

impl SchemaVariationWeights {
    fn mutate_weights<R: Rand>(
        rand: &mut R,
        guess: &mut SignatureGuess,
    ) -> Result<MutationResult, libafl::Error> {
        // pick a type guess to mutate
        let idx = rand.between(0, guess.args.len());
        if idx == guess.args.len() {
            Ok(Self::mutate_type_guess(rand, &mut guess.ret))
        } else {
            Ok(Self::mutate_type_guess(
                rand,
                guess.args.get_mut(idx).unwrap(),
            ))
        }
    }

    fn mutate_type_guess<R: Rand>(rand: &mut R, guess: &mut TypeGuess) -> MutationResult {
        if guess.is_any {
            return MutationResult::Skipped;
        }

        redistribute(rand, &mut guess.kind);

        if let Some(class_type) = &mut guess.class_type {
            redistribute(rand, class_type);
        }

        if let Some(object_shape) = &mut guess.object_shape {
            for prop_guess in object_shape.values_mut() {
                Self::mutate_type_guess(rand, prop_guess);
            }
        }

        if let Some(array_value_type) = &mut guess.array_value_type {
            Self::mutate_type_guess(rand, array_value_type);
        }

        MutationResult::Mutated
    }
}

impl<S, I> ReversibleMutator<S, I> for SchemaVariationWeights
where
    S: HasRand,
    I: HasSchema + Input,
{
    fn perform(&mut self, state: &mut S, input: &mut I) -> Result<MutationResult, libafl::Error> {
        apply_schema_mutation(state.rand_mut(), input, Self::mutate_weights)
    }
}

impl SchemaVariationMakeNullable {
    fn make_nullable<R: Rand>(
        rand: &mut R,
        guess: &mut SignatureGuess,
    ) -> Result<MutationResult, libafl::Error> {
        // pick a type guess to mutate
        let idx = if matches!(guess.callconv, CallConvention::Method)
            && MUTATE_SCHEMA_PRESERVE_CLASS_STRUCTURE
        {
            rand.between(1, guess.args.len())
        } else {
            rand.between(0, guess.args.len())
        };
        if idx == guess.args.len() {
            Ok(Self::mutate_type_guess(rand, &mut guess.ret))
        } else {
            Ok(Self::mutate_type_guess(
                rand,
                guess.args.get_mut(idx).unwrap(),
            ))
        }
    }

    fn mutate_type_guess<R: Rand>(rand: &mut R, guess: &mut TypeGuess) -> MutationResult {
        if guess.is_any {
            return MutationResult::Skipped;
        }

        let mut skipped = true;

        #[expect(clippy::map_entry)]
        if !guess.kind.contains_key(&TypeKind::Null) {
            guess.kind.insert(TypeKind::Null, 0.0);
            skipped = false;
        }

        #[expect(clippy::map_entry)]
        if !guess.kind.contains_key(&TypeKind::Undefined) {
            guess.kind.insert(TypeKind::Undefined, 0.0);
            skipped = false;
        }

        if skipped {
            MutationResult::Skipped
        } else {
            redistribute(rand, &mut guess.kind);
            MutationResult::Mutated
        }
    }
}

impl<S, I> ReversibleMutator<S, I> for SchemaVariationMakeNullable
where
    S: HasRand,
    I: HasSchema + Input,
{
    fn perform(&mut self, state: &mut S, input: &mut I) -> Result<MutationResult, libafl::Error> {
        apply_schema_mutation(state.rand_mut(), input, Self::make_nullable)
    }
}

pub struct SpliceSeq<'a> {
    pub schema: &'a Schema,
}

impl<'a> Named for SpliceSeq<'a> {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("SpliceSeq");
        &NAME
    }
}

impl<'a, S: HasRand> Mutator<ApiSeq, S> for SpliceSeq<'a> {
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<LibAflMutationResult, libafl::Error> {
        if input.seq_len() < 2 {
            return Ok(LibAflMutationResult::Skipped);
        }

        // remove a random API call
        let rand = state.rand_mut();
        let to_remove = rand.between(0, input.seq_len() - 1);

        input.remove_call(to_remove);
        input
            .complete(rand, self.schema)
            .map_err(|err| libafl::Error::unknown(format!("{}", err)))?;

        input.is_valid();
        Ok(LibAflMutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

pub struct ExtendSeq<'a> {
    pub schema: &'a Schema,
}

impl<'a> Named for ExtendSeq<'a> {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("ExtendSeq");
        &NAME
    }
}

impl<'a, S: HasRand> Mutator<ApiSeq, S> for ExtendSeq<'a> {
    fn mutate(
        &mut self,
        state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<LibAflMutationResult, libafl::Error> {
        let rand = state.rand_mut();
        let key = rand.choose(self.schema.keys()).unwrap();
        let sig = self.schema.get(key).unwrap();

        input.append_call(key.clone(), sig.args.len(), sig.callconv);
        input
            .complete(rand, self.schema)
            .map_err(|err| libafl::Error::unknown(format!("{}", err)))?;

        input.is_valid();
        Ok(LibAflMutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}

/// Remove the last call
pub struct TruncateSeq {}

impl Named for TruncateSeq {
    fn name(&self) -> &Cow<'static, str> {
        static NAME: Cow<'static, str> = Cow::Borrowed("TruncateSeq");
        &NAME
    }
}

impl<S: HasRand> Mutator<ApiSeq, S> for TruncateSeq {
    fn mutate(
        &mut self,
        _state: &mut S,
        input: &mut ApiSeq,
    ) -> Result<LibAflMutationResult, libafl::Error> {
        if input.seq_len() < 2 {
            return Ok(LibAflMutationResult::Skipped);
        }

        let new_size = input.seq_len() - 1;
        input.seq_mut().truncate(new_size);

        input.is_valid();

        Ok(LibAflMutationResult::Mutated)
    }

    fn post_exec(
        &mut self,
        _state: &mut S,
        _new_corpus_id: Option<CorpusId>,
    ) -> Result<(), libafl::Error> {
        Ok(())
    }
}
