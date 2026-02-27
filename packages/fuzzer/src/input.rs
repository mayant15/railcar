use anyhow::{bail, Result};
use libafl::{
    inputs::{HasMutatorBytes, HasTargetBytes, Input, ResizableMutator},
    state::DEFAULT_MAX_SIZE,
};
use libafl_bolts::{ownedref::OwnedSlice, rands::Rand, HasLen};
use serde::{Deserialize, Serialize};

#[expect(clippy::disallowed_types)]
use std::collections::{HashMap, HashSet};

use std::{
    collections::VecDeque,
    hash::{Hash, Hasher},
    num::NonZeroUsize,
    path::Path,
};

use crate::{
    rng::{redistribute, TrySample},
    schema::{CallConvention, EndpointName, Schema, SignatureGuess, Type, TypeGuess, TypeKind},
};

// TODO: Something other than String might be faster to work with
type CallId = String;

const MAX_SEQ_LEN: usize = 15;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApiCall {
    pub id: CallId,
    pub name: EndpointName,
    pub args: Vec<ApiCallArg>,
    pub conv: CallConvention,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ApiCallArg {
    Output(CallId),
    Constant(Type),
    Missing,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApiSeq {
    #[serde(with = "serde_bytes")]
    fuzz: Vec<u8>,
    seq: Vec<ApiCall>,
}

enum ArgFillStrategy {
    Constant,
    Reuse,
    New,
}

/// NOTE: This is only used in integration tests.
impl PartialEq for ApiSeq {
    /// Checks if the same APIs are called in the same order and with the same arguments
    fn eq(&self, other: &Self) -> bool {
        use std::iter::zip;

        if self.fuzz != other.fuzz {
            return false;
        }

        #[expect(clippy::disallowed_types)]
        let call_id_index_a: HashMap<&String, usize> = self
            .seq()
            .iter()
            .enumerate()
            .map(|(index, call)| (&call.id, index))
            .collect();

        #[expect(clippy::disallowed_types)]
        let call_id_index_b: HashMap<&String, usize> = other
            .seq()
            .iter()
            .enumerate()
            .map(|(index, call)| (&call.id, index))
            .collect();

        for (call_a, call_b) in zip(self.seq(), other.seq()) {
            if call_a.name != call_b.name {
                return false;
            }

            for args in zip(&call_a.args, &call_b.args) {
                match args {
                    (ApiCallArg::Missing, ApiCallArg::Missing) => {}

                    (ApiCallArg::Constant(ta), ApiCallArg::Constant(tb)) => {
                        if ta != tb {
                            return false;
                        }
                    }

                    (ApiCallArg::Output(ia), ApiCallArg::Output(ib)) => {
                        let ida = call_id_index_a[ia];
                        let idb = call_id_index_b[ib];

                        if ida != idb {
                            return false;
                        }
                    }

                    // they're different tags, cannot be equal
                    _ => return false,
                }
            }
        }

        true
    }
}

impl ApiSeq {
    fn next_id() -> CallId {
        // TODO: Can replace this with any other more lightweight ID, as long as we
        // handle potential collisions during sequence crossover
        uuid::Uuid::new_v4().to_string()
    }

    pub fn seq_mut(&mut self) -> &mut Vec<ApiCall> {
        &mut self.seq
    }

    pub fn seq(&self) -> &[ApiCall] {
        self.seq.as_slice()
    }

    pub fn seq_len(&self) -> usize {
        self.seq.len()
    }

    pub fn bytes(&self) -> &[u8] {
        self.fuzz.as_slice()
    }

    /// Regenerate new call IDs. Useful for handling collisions during crossover.
    pub fn generate_fresh_ids(&mut self) {
        #[expect(clippy::disallowed_types)]
        let new_ids: HashMap<CallId, CallId> = self
            .seq
            .iter()
            .map(|call| (call.id.clone(), Self::next_id()))
            .collect();

        for call in &mut self.seq {
            call.id = new_ids.get(&call.id).unwrap().clone();
            for arg in &mut call.args {
                if let ApiCallArg::Output(out) = arg {
                    let new_id = new_ids.get(out).unwrap().clone();
                    *arg = ApiCallArg::Output(new_id);
                }
            }
        }
    }

    pub fn create<R: Rand>(rand: &mut R, schema: &Schema, fuzz: Vec<u8>) -> Result<Self> {
        let Some((name, sig)) = rand.choose(schema.iter()) else {
            bail!("empty schema");
        };

        let mut seq = ApiSeq {
            fuzz,
            seq: Vec::new(),
        };
        let first = seq.append(name.clone(), sig.args.len(), sig.callconv);

        let mut worklist = VecDeque::new();
        worklist.push_back(first.id.clone());

        while let Some(index) = worklist.pop_front() {
            seq.complete_one(rand, schema, &mut worklist, index)?;
        }

        Ok(seq)
    }

    pub fn complete<R: Rand>(&mut self, rand: &mut R, schema: &Schema) -> Result<()> {
        let mut worklist = VecDeque::new();
        for call in &self.seq {
            let is_incomplete = call
                .args
                .iter()
                .any(|arg| matches!(arg, ApiCallArg::Missing));
            if is_incomplete {
                worklist.push_back(call.id.clone())
            }
        }

        while let Some(id) = worklist.pop_front() {
            self.complete_one(rand, schema, &mut worklist, id)?;
        }

        Ok(())
    }

    /// Find the index of the specified call ID
    fn index_of(&self, id: CallId) -> Option<usize> {
        for (index, call) in self.seq.iter().enumerate() {
            if call.id == id {
                return Some(index);
            }
        }
        None
    }

    /// Remove the call at the specified index
    pub fn remove(&mut self, index: usize) {
        let id = self.seq[index].id.clone();
        self.seq.remove(index);

        // adjust references to the removed call
        for idx in index..self.seq.len() {
            for arg in &mut self.seq[idx].args {
                if let ApiCallArg::Output(out) = arg {
                    if *out == id {
                        *arg = ApiCallArg::Missing;
                    }
                }
            }
        }
    }

    /// Add a new call to the end of the sequence
    pub fn append(&mut self, name: EndpointName, argc: usize, conv: CallConvention) -> &ApiCall {
        let mut args = Vec::new();
        args.resize(argc, ApiCallArg::Missing);
        self.seq.push(ApiCall {
            name,
            args,
            conv,
            id: Self::next_id(),
        });
        self.seq.last().unwrap()
    }

    /// Remove the first node in the sequence
    pub fn shift(&mut self) {
        let id = self.seq[0].id.clone();
        for call in &mut self.seq {
            for arg in &mut call.args {
                if let ApiCallArg::Output(out) = arg {
                    if *out == id {
                        *arg = ApiCallArg::Missing;
                    }
                }
            }
        }
    }

    #[inline]
    fn arg(&self, call_index: usize, arg_index: usize) -> &ApiCallArg {
        &self.seq[call_index].args[arg_index]
    }

    #[inline]
    fn arg_mut(&mut self, call_index: usize, arg_index: usize) -> &mut ApiCallArg {
        &mut self.seq[call_index].args[arg_index]
    }

    fn pick_arg_fill_strat<R: Rand>(&self, rand: &mut R, guess: &TypeGuess) -> ArgFillStrategy {
        if Self::only_class(guess) {
            if self.seq.len() > MAX_SEQ_LEN {
                return ArgFillStrategy::Reuse;
            }

            // either reuse, or new API call
            if rand.coinflip(0.5) {
                ArgFillStrategy::Reuse
            } else {
                ArgFillStrategy::New
            }
        } else {
            if self.seq.len() > MAX_SEQ_LEN {
                return ArgFillStrategy::Constant;
            }

            // pick one of three
            let idx = rand.below(NonZeroUsize::new(3).unwrap());
            match idx {
                0 => ArgFillStrategy::New,
                1 => ArgFillStrategy::Reuse,
                2 => ArgFillStrategy::Constant,
                _ => unreachable!(),
            }
        }
    }

    #[inline]
    fn only_class(guess: &TypeGuess) -> bool {
        guess.kind.len() == 1 && guess.kind.contains_key(&TypeKind::Class)
    }

    /// Fill in missing arguments for a single API call
    fn complete_one<R: Rand>(
        &mut self,
        rand: &mut R,
        schema: &Schema,
        worklist: &mut VecDeque<CallId>,
        id: CallId,
    ) -> Result<()> {
        let mut call_idx = self.index_of(id).unwrap();
        let sig = schema.get(&self.seq[call_idx].name).unwrap();

        for (arg_idx, guess) in sig.args.iter().enumerate() {
            if !matches!(self.arg(call_idx, arg_idx), ApiCallArg::Missing) {
                continue;
            }

            let strat = self.pick_arg_fill_strat(rand, guess);

            if let ArgFillStrategy::Reuse = strat {
                if let Some(out) = self.find_output_before(rand, call_idx, guess, schema) {
                    *self.arg_mut(call_idx, arg_idx) = ApiCallArg::Output(out.clone());
                    continue;
                }
            }

            // At this point we either chose to add a new API call, or couldn't reuse anything

            if matches!(strat, ArgFillStrategy::New | ArgFillStrategy::Reuse) {
                if let Some((new_api_name, new_api_sig)) = Self::pick_api(rand, schema, guess) {
                    let argc = new_api_sig.args.len();
                    let mut args = Vec::new();
                    args.resize(argc, ApiCallArg::Missing);

                    let new_call_id = Self::next_id();
                    *self.arg_mut(call_idx, arg_idx) = ApiCallArg::Output(new_call_id.clone());

                    // insert the new API call right before the one we're trying to fill
                    self.seq.insert(
                        call_idx,
                        ApiCall {
                            id: new_call_id.clone(),
                            name: new_api_name.clone(),
                            args,
                            conv: new_api_sig.callconv,
                        },
                    );
                    call_idx += 1; // we added a call, so adjust this accordingly
                    worklist.push_back(new_call_id);

                    continue;
                }
            }

            // At this point we either chose to add a constant or nothing else worked.

            // if this can only be a class, we can't create it here, pass null
            if Self::only_class(guess) {
                *self.arg_mut(call_idx, arg_idx) = ApiCallArg::Constant(Type::Null);
            } else {
                let guess = Self::strip_class(rand, guess);
                let typ = guess.sample(rand)?;
                *self.arg_mut(call_idx, arg_idx) = ApiCallArg::Constant(typ);
            }
        }

        Ok(())
    }

    fn strip_class<R: Rand>(rand: &mut R, guess: &TypeGuess) -> TypeGuess {
        let mut clone = guess.clone();
        clone.kind.remove(&TypeKind::Class);
        clone.class_type = None;
        redistribute(rand, &mut clone.kind);
        clone
    }

    fn find_output_before<R: Rand>(
        &self,
        rand: &mut R,
        index: usize,
        guess: &TypeGuess,
        schema: &Schema,
    ) -> Option<&CallId> {
        rand.choose(
            self.seq
                .iter()
                .take(index)
                .filter(|call| {
                    let sig = schema.get(&call.name).unwrap();

                    // TODO: probability scores will help here
                    sig.ret.overlaps(guess)
                })
                .map(|call| &call.id),
        )
    }

    fn pick_api<'a, R: Rand>(
        rand: &mut R,
        schema: &'a Schema,
        target: &TypeGuess,
    ) -> Option<(&'a EndpointName, &'a SignatureGuess)> {
        rand.choose(schema.iter().filter(|(_, sig)| sig.ret.overlaps(target)))
    }

    pub fn is_valid(&self) {
        let mut found = HashSet::new();
        for call in &self.seq {
            for arg in &call.args {
                match arg {
                    ApiCallArg::Constant(_) => (),
                    ApiCallArg::Missing => unreachable!(), // missing argument
                    // this should be an output of a previous call
                    ApiCallArg::Output(out) => assert!(found.contains(out)),
                }
            }
            assert!(found.insert(&call.id));
        }
    }
}

impl Hash for ApiSeq {
    fn hash<H: Hasher>(&self, state: &mut H) {
        #[expect(clippy::disallowed_methods)]
        let ser = rmp_serde::to_vec(self).expect("failed to serialize seq for hash");
        ser.hash(state);
    }
}

impl Input for ApiSeq {
    fn to_file<P>(&self, path: P) -> Result<(), libafl::Error>
    where
        P: AsRef<Path>,
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
        P: AsRef<Path>,
    {
        let file = std::fs::File::open(path)?;
        let deserialized = rmp_serde::from_read(file)
            .map_err(|e| libafl::Error::unknown(format!("failed to load input {}", e)))?;
        Ok(deserialized)
    }
}

impl HasLen for ApiSeq {
    fn len(&self) -> usize {
        self.fuzz.len()
    }
}

impl HasMutatorBytes for ApiSeq {
    fn mutator_bytes(&self) -> &[u8] {
        &self.fuzz
    }

    fn mutator_bytes_mut(&mut self) -> &mut [u8] {
        &mut self.fuzz
    }
}

impl ResizableMutator<u8> for ApiSeq {
    fn resize(&mut self, new_len: usize, value: u8) {
        ResizableMutator::resize(&mut self.fuzz, new_len, value)
    }

    fn extend<'a, I: IntoIterator<Item = &'a u8>>(&mut self, iter: I)
    where
        u8: 'a,
    {
        ResizableMutator::extend(&mut self.fuzz, iter)
    }

    fn splice<R, I>(&mut self, range: R, replace_with: I) -> std::vec::Splice<'_, I::IntoIter>
    where
        R: std::ops::RangeBounds<usize>,
        I: IntoIterator<Item = u8>,
    {
        ResizableMutator::splice(&mut self.fuzz, range, replace_with)
    }

    fn drain<R>(&mut self, range: R) -> std::vec::Drain<'_, u8>
    where
        R: std::ops::RangeBounds<usize>,
    {
        ResizableMutator::drain(&mut self.fuzz, range)
    }
}

impl HasTargetBytes for ApiSeq {
    fn target_bytes(&self) -> OwnedSlice<'_, u8> {
        rmp_serde::to_vec_named(self)
            .expect("failed to create bytes from sequence")
            .into()
    }
}

#[cfg(test)]
mod tests {
    #[expect(clippy::disallowed_types)]
    use std::collections::HashSet;

    use libafl::inputs::Input;
    use libafl_bolts::rands::{Rand, StdRand};
    use serde_json::{from_value, json};

    use super::{ApiCallArg, ApiSeq};
    use crate::schema::Schema;

    #[test]
    fn test_unequal_seq() {
        let seq_a: ApiSeq = from_value(json!({
            "fuzz": [],
            "seq": [
                {
                    "id": "813b25c3-a6de-455b-a43e-f2a9167a4c67",
                    "name": "encode",
                    "args": [
                        {
                            "Constant": {
                                "Object": {
                                    "comments": {
                                        "Array": "String"
                                    },
                                    "data": {
                                        "Class": "Uint8Array"
                                    },
                                    "height": "Number",
                                    "width": "Number"
                                }
                            }
                        },
                        {
                            "Constant": "Number"
                        }
                    ],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        let seq_b: ApiSeq = from_value(json!({
            "fuzz": [],
            "seq":  [
                {
                    "id": "a5544ca6-e17b-4bf3-994c-ebf91e08ad4c",
                    "name": "encode",
                    "args": [
                        {
                            "Constant": {
                                "Object": {
                                    "comments": "Undefined",
                                    "data": {
                                        "Class": "Buffer"
                                    },
                                    "height": "Number",
                                    "width": "Number"
                                }
                            }
                        },
                        {
                            "Constant": "Undefined"
                        }
                    ],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        assert_ne!(seq_a, seq_b);
    }

    fn load_schema(path: &str) -> Schema {
        let file = std::fs::File::open(path).expect("failed to open schema file");
        serde_json::from_reader(file).expect("failed to parse schema")
    }

    fn generate_seq(rand: &mut impl Rand, schema: &Schema) -> ApiSeq {
        let fuzz: Vec<u8> = (0..64).map(|_| rand.between(0, 255) as u8).collect();
        ApiSeq::create(rand, schema, fuzz).expect("failed to create ApiSeq")
    }

    #[test]
    fn test_create_valid_jpeg_js() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        let mut rand = StdRand::with_seed(42);
        let seq = generate_seq(&mut rand, &schema);
        seq.is_valid();
    }

    #[test]
    fn test_create_valid_fast_xml_parser() {
        let schema = load_schema("tests/common/fast-xml-parser-typescript.json");
        let mut rand = StdRand::with_seed(42);
        let seq = generate_seq(&mut rand, &schema);
        seq.is_valid();
    }

    #[test]
    fn test_create_valid_multiple_seeds() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        for seed in 0..50 {
            let mut rand = StdRand::with_seed(seed);
            let seq = generate_seq(&mut rand, &schema);
            seq.is_valid();
        }
    }

    #[test]
    fn test_shift_replaces_first_call_refs() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        let mut rand = StdRand::with_seed(42);
        let mut seq = generate_seq(&mut rand, &schema);

        let first_id = seq.seq()[0].id.clone();

        seq.shift();

        // All references to the first call's ID should now be Missing
        for call in seq.seq() {
            for arg in &call.args {
                if let ApiCallArg::Output(id) = arg {
                    assert_ne!(
                        *id, first_id,
                        "shift should replace all references to the first call with Missing"
                    );
                }
            }
        }
    }

    #[test]
    fn test_complete_fills_missing() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        let mut rand = StdRand::with_seed(42);

        let mut seq: ApiSeq = from_value(json!({
            "fuzz": [1, 2, 3],
            "seq": [
                {
                    "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "name": "encode",
                    "args": ["Missing", "Missing"],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        seq.complete(&mut rand, &schema).expect("complete failed");
        seq.is_valid();
    }

    #[test]
    fn test_generate_fresh_ids_changes_all_ids() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        let mut rand = StdRand::with_seed(42);
        let mut seq = generate_seq(&mut rand, &schema);

        let old_ids: HashSet<String> = seq.seq().iter().map(|c| c.id.clone()).collect();

        seq.generate_fresh_ids();

        let new_ids: HashSet<String> = seq.seq().iter().map(|c| c.id.clone()).collect();

        // No new ID should match any old ID
        assert!(
            old_ids.is_disjoint(&new_ids),
            "generate_fresh_ids should produce entirely new IDs"
        );
    }

    #[test]
    fn test_generate_fresh_ids_preserves_references() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        let mut rand = StdRand::with_seed(42);
        let mut seq = generate_seq(&mut rand, &schema);

        seq.generate_fresh_ids();

        // Build a set of call IDs seen so far (before the current call)
        let mut seen_ids: HashSet<String> = HashSet::new();
        for call in seq.seq() {
            for arg in &call.args {
                if let ApiCallArg::Output(ref_id) = arg {
                    assert!(
                        seen_ids.contains(ref_id),
                        "Output ref {} not found among earlier call IDs",
                        ref_id
                    );
                }
            }
            seen_ids.insert(call.id.clone());
        }
    }

    #[test]
    fn test_serialization_roundtrip() {
        let schema = load_schema("tests/common/jpeg-js-typescript.json");
        let mut rand = StdRand::with_seed(42);
        let seq = generate_seq(&mut rand, &schema);

        let path = "/tmp/railcar_test_roundtrip.msgpack";
        seq.to_file(&path).expect("to_file failed");
        let loaded = ApiSeq::from_file(&path).expect("from_file failed");
        let _ = std::fs::remove_file(&path);

        assert_eq!(seq, loaded);
    }

    #[test]
    #[should_panic]
    fn test_is_valid_catches_missing_args() {
        let seq: ApiSeq = from_value(json!({
            "fuzz": [],
            "seq": [
                {
                    "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "name": "foo",
                    "args": ["Missing"],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        seq.is_valid();
    }

    #[test]
    #[should_panic]
    fn test_is_valid_catches_forward_references() {
        // Call A references call B's output, but B comes AFTER A
        let seq: ApiSeq = from_value(json!({
            "fuzz": [],
            "seq": [
                {
                    "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "name": "foo",
                    "args": [{"Output": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}],
                    "conv": "Free"
                },
                {
                    "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "name": "bar",
                    "args": [],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        seq.is_valid();
    }

    #[test]
    #[should_panic]
    fn test_is_valid_catches_nonexistent_references() {
        // References an ID that doesn't exist anywhere in the sequence
        let seq: ApiSeq = from_value(json!({
            "fuzz": [],
            "seq": [
                {
                    "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "name": "foo",
                    "args": [{"Output": "cccccccc-cccc-cccc-cccc-cccccccccccc"}],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        seq.is_valid();
    }

    #[test]
    #[should_panic]
    fn test_is_valid_catches_duplicate_call_ids() {
        // Two calls with the same ID - is_valid checks via HashSet::insert which returns false on dup
        let seq: ApiSeq = from_value(json!({
            "fuzz": [],
            "seq": [
                {
                    "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "name": "foo",
                    "args": [],
                    "conv": "Free"
                },
                {
                    "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "name": "bar",
                    "args": [],
                    "conv": "Free"
                }
            ]
        }))
        .unwrap();

        seq.is_valid();
    }
}
