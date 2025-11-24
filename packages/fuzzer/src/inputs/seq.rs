use anyhow::{anyhow, bail, Result};
use libafl::{
    inputs::{HasMutatorBytes, Input, ResizableMutator},
    state::DEFAULT_MAX_SIZE,
};
use libafl_bolts::{rands::Rand, HasLen};
use serde::{Deserialize, Serialize};
use std::{
    hash::{Hash, Hasher},
    path::Path,
};

use crate::{
    config::SEQUENCE_COMPLETION_REUSE_RATE,
    inputs::{CanValidate, HasSeqLen, ToFuzzerInput},
    rng::{redistribute, TrySample},
    schema::{CallConvention, EndpointName, Schema, Type, TypeGuess, TypeKind},
    FuzzerConfig, FuzzerMode,
};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApiCall {
    name: EndpointName,
    args: Vec<ApiCallArg>,
    conv: CallConvention,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum ApiCallArg {
    Output(usize),
    Constant(Type),
    Missing,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApiSeq {
    #[serde(with = "serde_bytes")]
    fuzz: Vec<u8>,
    seq: Vec<ApiCall>,
}

impl ApiSeq {
    pub fn seq_mut(&mut self) -> &mut Vec<ApiCall> {
        &mut self.seq
    }

    pub fn create<R: Rand>(rand: &mut R, schema: &Schema, fuzz: Vec<u8>) -> Result<Self> {
        let Some((name, sig)) = rand.choose(schema.iter()) else {
            bail!("empty schema");
        };

        let mut seq = ApiSeq {
            fuzz,
            seq: Vec::new(),
        };
        seq.append_call(name.clone(), sig.args.len(), sig.callconv);

        let mut worklist = vec![0];
        while let Some(index) = worklist.pop() {
            seq.complete_with_consts(rand, schema, &mut worklist, index)?;
        }

        Ok(seq)
    }

    pub fn complete<R: Rand>(&mut self, rand: &mut R, schema: &Schema) -> Result<()> {
        let mut worklist = vec![];
        for (i, call) in self.seq.iter().enumerate() {
            let is_incomplete = call
                .args
                .iter()
                .any(|arg| matches!(arg, ApiCallArg::Missing));
            if is_incomplete {
                worklist.push(i)
            }
        }

        while let Some(index) = worklist.pop() {
            self.complete_with_consts(rand, schema, &mut worklist, index)?;
        }

        Ok(())
    }

    pub fn remove_call(&mut self, index: usize) {
        self.seq.remove(index);

        // adjust references to the removed call
        for idx in index..self.seq.len() {
            for arg in &mut self.seq[idx].args {
                match arg {
                    ApiCallArg::Output(out) => {
                        if *out < index {
                        } else if *out == index {
                            *arg = ApiCallArg::Missing;
                        } else {
                            *out -= 1;
                        }
                    }
                    ApiCallArg::Constant(_) => {}
                    ApiCallArg::Missing => unreachable!(),
                }
            }
        }
    }

    pub fn append_call(&mut self, name: EndpointName, argc: usize, conv: CallConvention) {
        let mut args = Vec::new();
        args.resize(argc, ApiCallArg::Missing);
        self.seq.push(ApiCall { name, args, conv });
    }

    fn complete_with_consts<R: Rand>(
        &mut self,
        rand: &mut R,
        schema: &Schema,
        worklist: &mut Vec<usize>,
        index: usize,
    ) -> Result<()> {
        assert!(self.seq.len() > index);

        let sig = schema.get(&self.seq[index].name).unwrap();

        let mut prefix = vec![];
        for (i, guess) in sig.args.iter().enumerate() {
            let call = self.seq.get(index).unwrap();
            if !matches!(call.args[i], ApiCallArg::Missing) {
                continue;
            }

            let should_reuse = rand.coinflip(SEQUENCE_COMPLETION_REUSE_RATE);
            if should_reuse {
                if let Some(out_idx) = self.find_output_before(rand, index, guess, schema) {
                    self.seq[index].args[i] = ApiCallArg::Output(out_idx);
                    continue;
                }
            }

            if guess.kind.len() == 1 && guess.kind.contains_key(&TypeKind::Class) {
                let name = guess
                    .class_type
                    .as_ref()
                    .ok_or(anyhow!(
                        "guess with non-zero probability of Class must have class_type"
                    ))?
                    .sample(rand)?;
                let argc = schema
                    .get(&name)
                    .ok_or(anyhow!("missing constructor for class {}", name))?
                    .args
                    .len();

                worklist.push(index + prefix.len());
                self.seq[index].args[i] = ApiCallArg::Output(index + prefix.len());

                let mut args = Vec::new();
                args.resize(argc, ApiCallArg::Missing);
                prefix.push(ApiCall {
                    name,
                    args,
                    conv: CallConvention::Constructor,
                });
            } else {
                let guess = Self::strip_class(rand, guess);
                let typ = guess.sample(rand)?;
                self.seq[index].args[i] = ApiCallArg::Constant(typ);
            }
        }

        // insert new required API calls
        let (head, tail) = self.seq.split_at(index);
        self.seq = [head, prefix.as_slice(), tail].concat();

        // adjust argument indices for every call after the one we just completed
        let new_index = prefix.len() + index;
        for i in (new_index + 1)..self.seq.len() {
            let call = self.seq.get_mut(i).unwrap();
            for arg in &mut call.args {
                let old_arg_index = if let ApiCallArg::Output(index) = arg {
                    *index
                } else {
                    continue;
                };
                if old_arg_index >= index {
                    *arg = ApiCallArg::Output(old_arg_index + prefix.len());
                }
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
    ) -> Option<usize> {
        rand.choose(
            self.seq
                .iter()
                .enumerate()
                .take(index)
                .filter(|(_, call)| {
                    let sig = schema.get(&call.name).unwrap();

                    // TODO: probability scores will help here
                    sig.ret.overlaps(guess)
                })
                .map(|(i, _)| i),
        )
    }
}

impl HasSeqLen for ApiSeq {
    fn seq_len(&self) -> usize {
        self.seq.len()
    }
}

impl Hash for ApiSeq {
    fn hash<H: Hasher>(&self, state: &mut H) {
        #[expect(clippy::disallowed_methods)]
        let ser = rmp_serde::to_vec(self).expect("failed to serialize graph for hash");
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

impl CanValidate for ApiSeq {
    fn is_valid(&self) {
        for (index, call) in self.seq.iter().enumerate() {
            for arg in &call.args {
                match arg {
                    ApiCallArg::Constant(_) => (),
                    ApiCallArg::Missing => unreachable!(), // missing argument
                    // this should be an output of a previous call
                    ApiCallArg::Output(out) => assert!(*out < index),
                }
            }
        }
    }
}

impl ToFuzzerInput for ApiSeq {
    fn to_fuzzer_input(&self, config: &FuzzerConfig) -> Result<Vec<u8>> {
        if !matches!(config.mode, FuzzerMode::Sequence) {
            bail!("sequence inputs need FuzzerMode::Sequence");
        }

        let bytes = match rmp_serde::to_vec_named(self) {
            Ok(bytes) => bytes,
            Err(e) => {
                bail!("failed to create bytes from sequence {}", e);
            }
        };

        Ok(bytes)
    }
}
