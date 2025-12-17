use libafl::{generators::Generator, state::HasRand};

use crate::{
    inputs::{graph::RailcarError, Graph},
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
