use anyhow::Result;
use libafl::inputs::{BytesInput, HasMutatorBytes, Input};

use crate::FuzzerConfig;

pub mod graph;

pub use graph::Graph;

pub trait HasSeqLen {
    fn seq_len(&self) -> usize;
}

pub trait CanValidate {
    fn is_valid(&self) {}
}

pub trait ToFuzzerInput: Input {
    fn to_fuzzer_input(&self, config: &FuzzerConfig) -> Result<Vec<u8>>;
}

impl ToFuzzerInput for BytesInput {
    fn to_fuzzer_input(&self, _: &FuzzerConfig) -> Result<Vec<u8>> {
        Ok(self.mutator_bytes().to_vec())
    }
}
