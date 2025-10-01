// SPDX-License-Identifier: AGPL-3.0-or-later

use criterion::{criterion_group, criterion_main, Criterion};
use libafl::{
    corpus::NopCorpus,
    feedbacks::ConstFeedback,
    mutators::Mutator,
    state::{HasRand, StdState},
};
use libafl_bolts::rands::{Rand, StdRand};
use railcar::mutation;
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

pub fn truncate(c: &mut Criterion) {
    let mut rand = StdRand::with_seed(SEED);

    let schema: Schema =
        serde_json::from_slice(SCHEMA.as_bytes()).expect("failed to deserialize schema");

    let nr_inputs = rand.between(0, 256);
    let mut inputs = generate_graphs(&mut rand, &schema, nr_inputs as usize);
    let mut state = make_state(rand);
    let mut tr = mutation::Truncate::new();

    c.bench_function("Truncate", |b| {
        b.iter(|| {
            let idx = state.rand_mut().between(0, inputs.len() - 1);
            let _ = tr.mutate(&mut state, inputs.get_mut(idx).unwrap());
        });
    });
}

criterion_group! {
    name = mutation;
    config = Criterion::default();
    targets = truncate
}
criterion_main!(mutation);
