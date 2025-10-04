// SPDX-License-Identifier: AGPL-3.0-or-later

#![allow(non_snake_case)]

use criterion::{criterion_group, criterion_main, Criterion};
use libafl::{
    corpus::NopCorpus,
    feedbacks::ConstFeedback,
    mutators::Mutator,
    state::{HasRand, StdState},
};
use libafl_bolts::rands::{Rand, StdRand};
use railcar::mutation as muta;
use railcar_graph::{Graph, Schema};

const SEED: u64 = 1234;

type State = StdState<NopCorpus<Graph>, Graph, StdRand, NopCorpus<Graph>>;

fn generate_graphs<R: Rand>(rand: &mut R, schema: &Schema, nr: usize) -> Vec<Graph> {
    let mut graphs = Vec::with_capacity(nr);
    let mut buf: Vec<u8> = Vec::with_capacity(256);

    for _ in 0..nr {
        let seed = rand.next();
        let buf_size = rand.between(16, 256);
        buf.resize(buf_size, 0);

        for i in 0..buf_size {
            buf[i] = rand.between(0, 256) as u8;
        }

        if let Ok(graph) = Graph::create_from_bytes(seed, buf.as_slice(), schema) {
            graphs.push(graph);
        } else {
            // failed to generate a graph, just make another
            continue;
        }
    }

    return graphs;
}

fn make_state(rand: StdRand) -> State {
    let mut feedback = ConstFeedback::new(false);
    let mut objective = ConstFeedback::new(false);
    State::new(
        rand,
        NopCorpus::new(),
        NopCorpus::new(),
        &mut feedback,
        &mut objective,
    )
    .expect("failed to create state")
}

const SCHEMA: &str = include_str!("schema.json");

macro_rules! make_bench_for {
    ($x:ident) => {
        pub fn $x(c: &mut Criterion) {
            let mut rand = StdRand::with_seed(SEED);

            let schema: Schema =
                serde_json::from_slice(SCHEMA.as_bytes()).expect("failed to deserialize schema");

            let nr_inputs = rand.between(0, 256);
            let mut inputs = generate_graphs(&mut rand, &schema, nr_inputs as usize);
            let mut state = make_state(rand);
            let mut mutation = muta::$x::new();

            c.bench_function(stringify!($x), |b| {
                b.iter(|| {
                    let idx = state.rand_mut().between(0, inputs.len() - 1);
                    let _ = mutation.mutate(&mut state, inputs.get_mut(idx).unwrap());
                });
            });
        }
    };
}

make_bench_for!(Truncate);
make_bench_for!(Extend);
make_bench_for!(SpliceIn);
make_bench_for!(SpliceOut);
make_bench_for!(Crossover);
make_bench_for!(Context);
make_bench_for!(Swap);
make_bench_for!(Priority);
make_bench_for!(TruncateDestructor);
make_bench_for!(ExtendDestructor);
make_bench_for!(TruncateConstructor);
make_bench_for!(ExtendConstructor);
make_bench_for!(SchemaVariationArgc);
make_bench_for!(SchemaVariationWeights);
make_bench_for!(SchemaVariationMakeNullable);

criterion_group!(
    mutation,
    Truncate,
    Extend,
    SpliceIn,
    SpliceOut,
    Context,
    Swap,
    Priority,
    TruncateDestructor,
    ExtendDestructor,
    TruncateConstructor,
    ExtendConstructor,
    SchemaVariationArgc,
    SchemaVariationWeights,
    SchemaVariationMakeNullable,
);
criterion_main!(mutation);
