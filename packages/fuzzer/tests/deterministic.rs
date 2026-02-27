use std::{num::NonZero, path::Path};

use anyhow::Result;

use libafl::{corpus::NopCorpus, feedbacks::ConstFeedback, generators::Generator, state::StdState};
use libafl_bolts::{
    generic_hash_std,
    rands::{Rand, StdRand},
};
use railcar::{
    schema::Schema,
    seq::{ApiSeq, ApiSeqGenerator},
};

const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();
const MIN_INPUT_LENGTH: NonZero<usize> = NonZero::new(8).unwrap();

#[test]
fn deterministic_rand() {
    let seed = 20061;

    let mut ra = StdRand::with_seed(seed);
    let mut rb = StdRand::with_seed(seed);

    for _ in 0..1000000 {
        assert_eq!(ra.next(), rb.next())
    }
}

#[test]
fn deterministic_hash() -> Result<()> {
    let schema_file = std::fs::File::open("tests/common/fast-xml-parser-typescript.json")?;
    let schema: Schema = serde_json::from_reader(schema_file)?;

    let mut feedback = ConstFeedback::False;
    let mut objective = ConstFeedback::False;

    let seed = 20061;

    let mut state = StdState::new(
        StdRand::with_seed(seed),
        NopCorpus::<ApiSeq>::new(),
        NopCorpus::new(),
        &mut feedback,
        &mut objective,
    )?;
    let mut generator = ApiSeqGenerator::new(&schema, MIN_INPUT_LENGTH, MAX_INPUT_LENGTH);

    for _ in 0..1000 {
        let input = generator.generate(&mut state)?;
        let ha = generic_hash_std(&input);
        let hb = generic_hash_std(&input);

        assert_eq!(ha, hb);
    }

    Ok(())
}

fn deterministic_seq_generator_for_schema<P: AsRef<Path>>(path: P) -> Result<()> {
    let schema_file = std::fs::File::open(path)?;
    let schema: Schema = serde_json::from_reader(schema_file)?;

    let mut feedback = ConstFeedback::False;
    let mut objective = ConstFeedback::False;

    let seed = 20061;

    let mut sa = StdState::new(
        StdRand::with_seed(seed),
        NopCorpus::<ApiSeq>::new(),
        NopCorpus::new(),
        &mut feedback,
        &mut objective,
    )?;
    let mut ga = ApiSeqGenerator::new(&schema, MIN_INPUT_LENGTH, MAX_INPUT_LENGTH);

    let mut sb = StdState::new(
        StdRand::with_seed(seed),
        NopCorpus::<ApiSeq>::new(),
        NopCorpus::new(),
        &mut feedback,
        &mut objective,
    )?;
    let mut gb = ApiSeqGenerator::new(&schema, MIN_INPUT_LENGTH, MAX_INPUT_LENGTH);

    for _ in 0..1000 {
        let ia = ga.generate(&mut sa)?;
        let ib = gb.generate(&mut sb)?;
        assert_eq!(ia, ib);
    }

    Ok(())
}

#[test]
fn deterministic_seq_generator_fast_xml_parser() -> Result<()> {
    deterministic_seq_generator_for_schema("tests/common/fast-xml-parser-typescript.json")
}

#[test]
fn deterministic_seq_generator_jpeg_js() -> Result<()> {
    deterministic_seq_generator_for_schema("tests/common/jpeg-js-typescript.json")
}
