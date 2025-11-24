use anyhow::{bail, Result};
use std::hash::{Hash, Hasher};

use libafl::{
    inputs::{HasMutatorBytes, Input, ResizableMutator},
    state::DEFAULT_MAX_SIZE,
};
use libafl_bolts::HasLen;
use serde::{Deserialize, Serialize};

use crate::{
    inputs::{CanValidate, Graph, HasSeqLen, ToFuzzerInput},
    schema::{HasSchema, Schema},
    FuzzerConfig,
};

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

impl CanValidate for ParametricGraph {}

impl HasSeqLen for ParametricGraph {
    fn seq_len(&self) -> usize {
        1
    }
}

impl ToFuzzerInput for ParametricGraph {
    fn to_fuzzer_input(&self, config: &FuzzerConfig) -> Result<Vec<u8>> {
        let graph = match Graph::create_from_bytes(config.seed, self.mutator_bytes(), self.schema())
        {
            Ok(graph) => graph,
            Err(e) => {
                bail!("failed to create graph from bytes {}", e);
            }
        };

        let bytes = match rmp_serde::to_vec_named(&graph) {
            Ok(bytes) => bytes,
            Err(e) => {
                bail!("failed to create bytes from graph {}", e);
            }
        };

        Ok(bytes)
    }
}
