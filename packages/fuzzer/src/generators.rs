use libafl::{
    generators::{Generator, RandBytesGenerator},
    state::HasRand,
};

use crate::{
    config::{MAX_INPUT_LENGTH, MIN_INPUT_LENGTH},
    inputs::{graph::RailcarError, ApiSeq, Graph, ParametricGraph},
    schema::Schema,
};

pub struct GraphGenerator<'a> {
    schema: &'a Schema,
}

impl<'a> GraphGenerator<'a> {
    pub fn new(schema: &'a Schema) -> Self {
        Self { schema }
    }
}

impl<S: HasRand> Generator<Graph, S> for GraphGenerator<'_> {
    fn generate(&mut self, state: &mut S) -> Result<Graph, libafl::Error> {
        match Graph::create(state.rand_mut(), self.schema) {
            Ok(graph) => Ok(graph),
            Err(e) => match e {
                RailcarError::HugeGraph => {
                    Graph::create_small(state.rand_mut(), self.schema).map_err(|e| e.into())
                }
                RailcarError::Unknown(msg) => Err(libafl::Error::unknown(format!("{}", msg))),
            },
        }
    }
}

pub struct ParametricGenerator<'a> {
    schema: &'a Schema,
    bytes_gen: RandBytesGenerator,
}

impl<'a> ParametricGenerator<'a> {
    pub fn new(schema: &'a Schema) -> Self {
        Self {
            schema,
            bytes_gen: RandBytesGenerator::with_min_size(MIN_INPUT_LENGTH, MAX_INPUT_LENGTH),
        }
    }
}

impl<S: HasRand> Generator<ParametricGraph, S> for ParametricGenerator<'_> {
    fn generate(&mut self, state: &mut S) -> Result<ParametricGraph, libafl::Error> {
        let bytes = self.bytes_gen.generate(state)?;
        Ok(ParametricGraph::new(self.schema.clone(), bytes.into()))
    }
}

pub struct ApiSeqGenerator<'a> {
    schema: &'a Schema,
    bytes_gen: RandBytesGenerator,
}

impl<'a> ApiSeqGenerator<'a> {
    pub fn new(schema: &'a Schema) -> Self {
        Self {
            schema,
            bytes_gen: RandBytesGenerator::with_min_size(MIN_INPUT_LENGTH, MAX_INPUT_LENGTH),
        }
    }
}

impl<S: HasRand> Generator<ApiSeq, S> for ApiSeqGenerator<'_> {
    fn generate(&mut self, state: &mut S) -> Result<ApiSeq, libafl::Error> {
        let bytes = self.bytes_gen.generate(state)?;
        ApiSeq::create(state.rand_mut(), self.schema, bytes.into()).map_err(|e| {
            libafl::Error::unknown(format!("failed to generate an api sequence: {}", e))
        })
    }
}
