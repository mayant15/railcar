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
    rng::{redistribute, TrySample},
    schema::{CallConvention, EndpointName, Schema, Type, TypeGuess, TypeKind},
};

pub type NodeId = usize;

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ApiCall {
    name: EndpointName,
    args: Vec<ApiCallArg>,
    conv: CallConvention,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
enum ApiCallArg {
    Output(usize),
    Constant(Type),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApiSeq {
    #[serde(with = "serde_bytes")]
    fuzz: Vec<u8>,
    seq: Vec<ApiCall>,
}

impl ApiSeq {
    pub fn create<R: Rand>(rand: &mut R, schema: &Schema, fuzz: Vec<u8>) -> Result<Self> {
        let Some((key, sig)) = rand.choose(schema.iter()) else {
            bail!("empty schema");
        };

        let mut seq = ApiSeq {
            fuzz,
            seq: Vec::new(),
        };

        seq.seq.push(ApiCall {
            name: key.clone(),
            args: Vec::new(),
            conv: sig.callconv.clone(),
        });

        let mut worklist = vec![0];
        while let Some(index) = worklist.pop() {
            seq.complete_with_consts(rand, schema, &mut worklist, index)?;
        }

        Ok(seq)
    }

    fn complete_with_consts<R: Rand>(
        &mut self,
        rand: &mut R,
        schema: &Schema,
        worklist: &mut Vec<usize>,
        index: usize,
    ) -> Result<()> {
        assert!(self.seq.len() > index);
        assert!(self.seq[index].args.is_empty());

        let call = self.seq.get_mut(index).unwrap();
        let sig = schema.get(&call.name).unwrap();

        let mut prefix = vec![];
        for guess in &sig.args {
            if guess.kind.len() == 1 && guess.kind.contains_key(&TypeKind::Class) {
                let name = guess
                    .class_type
                    .as_ref()
                    .ok_or(anyhow!(
                        "guess with non-zero probability of Class must have class_type"
                    ))?
                    .sample(rand)?;
                worklist.push(index + prefix.len());
                call.args.push(ApiCallArg::Output(index + prefix.len()));
                prefix.push(ApiCall {
                    name,
                    args: vec![],
                    conv: CallConvention::Constructor,
                });
            } else {
                let guess = Self::strip_class(rand, guess);
                let typ = guess.sample(rand)?;
                call.args.push(ApiCallArg::Constant(typ))
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
