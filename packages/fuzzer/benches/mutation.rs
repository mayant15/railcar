// SPDX-License-Identifier: AGPL-3.0-or-later

#![allow(non_snake_case)]

use criterion::{criterion_group, criterion_main, Criterion};
use libafl::{
    corpus::{Corpus, InMemoryCorpus, NopCorpus, Testcase},
    feedbacks::ConstFeedback,
    mutators::{havoc_mutations, HavocScheduledMutator, Mutator},
    state::{HasCorpus, HasRand},
};
use libafl_bolts::rands::{Rand, StdRand};
use railcar::{
    schema::Schema,
    seq::{self, ApiSeq},
};

const SEED: u64 = 1234;
const FUZZ_BUF_LEN: usize = 1024;
const SCHEMA: &str = include_str!("schema.json");

type StdState<C> = libafl::state::StdState<C, ApiSeq, StdRand, NopCorpus<ApiSeq>>;
type State = StdState<NopCorpus<ApiSeq>>;

fn generate_seqs<R: Rand>(rand: &mut R, schema: &Schema, nr: usize) -> Vec<ApiSeq> {
    let mut seqs = Vec::with_capacity(nr);

    for _ in 0..nr {
        let mut buf = Vec::new();
        buf.resize(rand.between(0, FUZZ_BUF_LEN - 1), 0);
        for i in 0..buf.len() {
            buf[i] = rand.between(0, FUZZ_BUF_LEN - 1) as u8;
        }

        if let Ok(seq) = ApiSeq::create(rand, schema, buf) {
            seqs.push(seq)
        }
    }

    return seqs;
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

fn bench<M>(c: &mut Criterion, name: &str, mutation: &mut M, schema: &Schema)
where
    M: Mutator<ApiSeq, State>,
{
    let mut rand = StdRand::with_seed(SEED);
    let nr_inputs = rand.between(0, 256);
    let mut inputs = generate_seqs(&mut rand, &schema, nr_inputs as usize);
    let mut state = make_state(rand);

    c.bench_function(name, |b| {
        b.iter(|| {
            let idx = state.rand_mut().between(0, inputs.len() - 1);
            let _ = mutation.mutate(&mut state, inputs.get_mut(idx).unwrap());
        });
    });
}

fn parse_schema() -> Schema {
    serde_json::from_slice(SCHEMA.as_bytes()).expect("failed to deserialize schema")
}

fn SpliceSeq(c: &mut Criterion) {
    let schema: Schema = parse_schema();
    let mut mutation = seq::SpliceSeq { schema: &schema };
    bench(c, "SpliceSeq", &mut mutation, &schema);
}

fn ExtendSeq(c: &mut Criterion) {
    let schema: Schema = parse_schema();
    let mut mutation = seq::ExtendSeq { schema: &schema };
    bench(c, "ExtendSeq", &mut mutation, &schema);
}

fn RemovePrefixSeq(c: &mut Criterion) {
    let schema: Schema = parse_schema();
    let mut mutation = seq::RemovePrefixSeq { schema: &schema };
    bench(c, "RemovePrefixSeq", &mut mutation, &schema);
}

fn RemoveSuffixSeq(c: &mut Criterion) {
    let schema: Schema = parse_schema();
    let mut mutation = seq::RemoveSuffixSeq {};
    bench(c, "RemoveSuffixSeq", &mut mutation, &schema);
}

fn Havoc(c: &mut Criterion) {
    let schema: Schema = parse_schema();
    let mut mutation = HavocScheduledMutator::new(havoc_mutations());
    bench(c, "Havoc", &mut mutation, &schema);
}

fn Crossover(c: &mut Criterion) {
    let schema: Schema = parse_schema();
    let mut mutation = seq::Crossover { schema: &schema };

    let mut rand = StdRand::with_seed(SEED);
    let nr_inputs = rand.between(0, 256);
    let mut inputs = generate_seqs(&mut rand, &schema, nr_inputs as usize);

    let mut feedback = ConstFeedback::new(false);
    let mut objective = ConstFeedback::new(false);
    let mut state = StdState::new(
        rand,
        InMemoryCorpus::new(),
        NopCorpus::new(),
        &mut feedback,
        &mut objective,
    )
    .expect("failed to create state");

    for input in &inputs {
        _ = state
            .corpus_mut()
            .add(Testcase::from(input.clone()))
            .unwrap();
    }

    c.bench_function("Crossover", |b| {
        b.iter(|| {
            let idx = state.rand_mut().between(0, inputs.len() - 1);
            let _ = mutation.mutate(&mut state, inputs.get_mut(idx).unwrap());
        });
    });
}

criterion_group!(
    mutation,
    SpliceSeq,
    ExtendSeq,
    RemovePrefixSeq,
    RemoveSuffixSeq,
    Crossover,
    Havoc,
);
criterion_main!(mutation);
