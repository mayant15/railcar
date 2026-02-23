use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

use libafl::{
    corpus::NopCorpus,
    feedbacks::ConstFeedback,
    inputs::Input,
    mutators::{MutationResult, Mutator},
    state::{HasRand, StdState},
};
use libafl_bolts::{core_affinity::Cores, generic_hash_std, rands::{Rand, StdRand}};
use railcar::{
    inputs::{CanValidate, HasSeqLen, ToFuzzerInput},
    schema::Schema,
    seq::{ApiSeq, ExtendSeq, RemovePrefixSeq, RemoveSuffixSeq, SpliceSeq},
    FuzzerConfig, FuzzerMode,
};

type NopState = StdState<NopCorpus<ApiSeq>, ApiSeq, StdRand, NopCorpus<ApiSeq>>;

fn load_schema(path: &str) -> Schema {
    let file = std::fs::File::open(path).expect("failed to open schema file");
    serde_json::from_reader(file).expect("failed to parse schema")
}

fn make_nop_state(seed: u64) -> NopState {
    let mut feedback = ConstFeedback::new(false);
    let mut objective = ConstFeedback::new(false);
    NopState::new(
        StdRand::with_seed(seed),
        NopCorpus::new(),
        NopCorpus::new(),
        &mut feedback,
        &mut objective,
    )
    .expect("failed to create state")
}

fn generate_seq(rand: &mut impl Rand, schema: &Schema) -> ApiSeq {
    let fuzz: Vec<u8> = (0..64).map(|_| rand.between(0, 255) as u8).collect();
    ApiSeq::create(rand, schema, fuzz).expect("failed to create ApiSeq")
}

fn apply_random_mutation(
    state: &mut NopState,
    input: &mut ApiSeq,
    schema: &Schema,
) -> MutationResult {
    let mut splice = SpliceSeq { schema };
    let mut extend = ExtendSeq { schema };
    let mut remove_suffix = RemoveSuffixSeq {};
    let mut remove_prefix = RemovePrefixSeq { schema };

    let pick = state.rand_mut().below_or_zero(4);
    let result = match pick {
        0 => splice.mutate(state, input),
        1 => extend.mutate(state, input),
        2 => remove_suffix.mutate(state, input),
        3 => remove_prefix.mutate(state, input),
        _ => unreachable!(),
    };

    result.unwrap_or(MutationResult::Skipped)
}

// ---------------------------------------------------------------------------
// Mutation stability tests
// ---------------------------------------------------------------------------

fn mutation_stability_for_schema(schema_path: &str) -> Result<()> {
    let schema = load_schema(schema_path);
    let seed = 12345;
    let mut state = make_nop_state(seed);
    let mut input = generate_seq(state.rand_mut(), &schema);

    for _ in 0..100 {
        apply_random_mutation(&mut state, &mut input, &schema);
        input.is_valid();
    }

    Ok(())
}

#[test]
fn mutation_stability_jpeg_js() -> Result<()> {
    mutation_stability_for_schema("tests/common/jpeg-js-typescript.json")
}

#[test]
fn mutation_stability_fast_xml_parser() -> Result<()> {
    mutation_stability_for_schema("tests/common/fast-xml-parser-typescript.json")
}

// ---------------------------------------------------------------------------
// End-to-end serialization roundtrip
// ---------------------------------------------------------------------------

#[test]
fn serialization_roundtrip() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");

    for seed in 0..50 {
        let mut rand = StdRand::with_seed(seed);
        let input = generate_seq(&mut rand, &schema);

        let path = format!("/tmp/railcar_integration_test_{seed}.msgpack");
        input.to_file(&path)?;
        let restored = ApiSeq::from_file(&path)?;
        std::fs::remove_file(&path).ok();

        assert_eq!(input, restored, "roundtrip failed for seed {seed}");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Property-based stress test over many seeds
// ---------------------------------------------------------------------------

#[test]
fn stress_test_generate_and_mutate() -> Result<()> {
    let schemas = [
        load_schema("tests/common/jpeg-js-typescript.json"),
        load_schema("tests/common/fast-xml-parser-typescript.json"),
    ];

    for schema in &schemas {
        for seed in 0..200 {
            let mut state = make_nop_state(seed);
            let mut input = generate_seq(state.rand_mut(), schema);
            input.is_valid();

            for _ in 0..20 {
                apply_random_mutation(&mut state, &mut input, schema);
                input.is_valid();
            }

            assert!(input.seq_len() >= 1, "seq must have at least one call");
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Mutation determinism
// ---------------------------------------------------------------------------

#[test]
fn mutation_determinism() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");
    let seed = 77777;

    let mut state_a = make_nop_state(seed);
    let mut input_a = generate_seq(state_a.rand_mut(), &schema);

    let mut state_b = make_nop_state(seed);
    let mut input_b = generate_seq(state_b.rand_mut(), &schema);

    assert_eq!(input_a, input_b, "initial generation should be identical");

    for i in 0..50 {
        let mut splice_a = SpliceSeq { schema: &schema };
        let mut extend_a = ExtendSeq { schema: &schema };
        let mut remove_suffix_a = RemoveSuffixSeq {};
        let mut remove_prefix_a = RemovePrefixSeq { schema: &schema };

        let mut splice_b = SpliceSeq { schema: &schema };
        let mut extend_b = ExtendSeq { schema: &schema };
        let mut remove_suffix_b = RemoveSuffixSeq {};
        let mut remove_prefix_b = RemovePrefixSeq { schema: &schema };

        let pick_a = state_a.rand_mut().below_or_zero(4);
        let pick_b = state_b.rand_mut().below_or_zero(4);
        assert_eq!(pick_a, pick_b, "random picks diverged at iteration {i}");

        match pick_a {
            0 => {
                splice_a.mutate(&mut state_a, &mut input_a).ok();
                splice_b.mutate(&mut state_b, &mut input_b).ok();
            }
            1 => {
                extend_a.mutate(&mut state_a, &mut input_a).ok();
                extend_b.mutate(&mut state_b, &mut input_b).ok();
            }
            2 => {
                remove_suffix_a.mutate(&mut state_a, &mut input_a).ok();
                remove_suffix_b.mutate(&mut state_b, &mut input_b).ok();
            }
            3 => {
                remove_prefix_a.mutate(&mut state_a, &mut input_a).ok();
                remove_prefix_b.mutate(&mut state_b, &mut input_b).ok();
            }
            _ => unreachable!(),
        };

        assert_eq!(input_a, input_b, "inputs diverged after mutation at iteration {i}");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// to_fuzzer_input() roundtrip
// ---------------------------------------------------------------------------

fn make_seq_config() -> FuzzerConfig {
    FuzzerConfig {
        port: 0,
        mode: FuzzerMode::Sequence,
        timeout: Duration::from_secs(5),
        corpus: PathBuf::from("/tmp/railcar_test_corpus"),
        crashes: PathBuf::from("/tmp/railcar_test_crashes"),
        metrics: PathBuf::from("/tmp/railcar_test_metrics"),
        seed: 0,
        entrypoint: PathBuf::from("/tmp/railcar_test_entry"),
        schema_file: None,
        replay: false,
        replay_input: None,
        config_file: None,
        cores: Cores::from_cmdline("0").unwrap(),
        labels: vec![],
        iterations: None,
        debug_dump_schema: None,
    }
}

#[test]
fn to_fuzzer_input_roundtrip() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");
    let config = make_seq_config();

    for seed in 0..50 {
        let mut rand = StdRand::with_seed(seed);
        let input = generate_seq(&mut rand, &schema);
        input.is_valid();

        let bytes = input.to_fuzzer_input(&config)?;
        let restored: ApiSeq = rmp_serde::from_slice(&bytes)
            .unwrap_or_else(|e| panic!("failed to deserialize to_fuzzer_input output for seed {seed}: {e}"));

        assert_eq!(input, restored, "to_fuzzer_input roundtrip failed for seed {seed}");
        restored.is_valid();
    }

    Ok(())
}

#[test]
fn to_fuzzer_input_rejects_wrong_mode() {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");
    let mut config = make_seq_config();
    config.mode = FuzzerMode::Graph;

    let mut rand = StdRand::with_seed(42);
    let input = generate_seq(&mut rand, &schema);

    assert!(input.to_fuzzer_input(&config).is_err());
}

// ---------------------------------------------------------------------------
// Hash consistency
// ---------------------------------------------------------------------------

#[test]
fn hash_equal_inputs_produce_equal_hashes() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");

    for seed in 0..50 {
        let mut rand = StdRand::with_seed(seed);
        let a = generate_seq(&mut rand, &schema);
        let b = a.clone();

        assert_eq!(a, b);
        assert_eq!(generic_hash_std(&a), generic_hash_std(&b),
            "equal inputs must have equal hashes for seed {seed}");
    }

    Ok(())
}

#[test]
fn hash_different_inputs_likely_differ() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");
    let mut collisions = 0;

    for seed in 0..100 {
        let mut rand_a = StdRand::with_seed(seed);
        let mut rand_b = StdRand::with_seed(seed + 1000);
        let a = generate_seq(&mut rand_a, &schema);
        let b = generate_seq(&mut rand_b, &schema);

        if generic_hash_std(&a) == generic_hash_std(&b) {
            collisions += 1;
        }
    }

    assert!(collisions < 5, "too many hash collisions: {collisions}/100");

    Ok(())
}

// ---------------------------------------------------------------------------
// Edge-case schemas
// ---------------------------------------------------------------------------

#[test]
fn create_with_empty_schema_fails() {
    let schema: Schema = serde_json::from_str("{}").unwrap();
    let mut rand = StdRand::with_seed(42);
    let fuzz: Vec<u8> = (0..64).map(|_| rand.between(0, 255) as u8).collect();
    let result = ApiSeq::create(&mut rand, &schema, fuzz);
    assert!(result.is_err(), "creating from empty schema should fail");
}

#[test]
fn create_with_single_no_arg_endpoint() {
    let schema: Schema = serde_json::from_value(serde_json::json!({
        "simple_fn": {
            "args": [],
            "ret": {
                "isAny": false,
                "kind": { "Number": 1.0 }
            },
            "callconv": "Free"
        }
    })).unwrap();

    for seed in 0..50 {
        let mut rand = StdRand::with_seed(seed);
        let seq = generate_seq(&mut rand, &schema);
        seq.is_valid();
        assert_eq!(seq.seq().len(), 1, "single no-arg endpoint should produce 1-call seqs");
    }
}

#[test]
fn create_with_constructor_only_schema() {
    let schema: Schema = serde_json::from_value(serde_json::json!({
        "MyClass": {
            "args": [],
            "ret": {
                "isAny": false,
                "kind": { "Class": 1.0 },
                "classType": { "MyClass": 1.0 }
            },
            "callconv": "Constructor"
        }
    })).unwrap();

    for seed in 0..50 {
        let mut rand = StdRand::with_seed(seed);
        let seq = generate_seq(&mut rand, &schema);
        seq.is_valid();
    }
}

// ---------------------------------------------------------------------------
// Composition chains
// ---------------------------------------------------------------------------

#[test]
fn composition_mutate_then_fresh_ids_then_complete() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");

    for seed in 0..100 {
        let mut state = make_nop_state(seed);
        let mut input = generate_seq(state.rand_mut(), &schema);
        input.is_valid();

        for _ in 0..5 {
            apply_random_mutation(&mut state, &mut input, &schema);
        }
        input.is_valid();

        input.generate_fresh_ids();

        input.is_valid();
    }

    Ok(())
}

#[test]
fn composition_remove_then_complete() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");

    for seed in 0..100 {
        let mut rand = StdRand::with_seed(seed);
        let mut seq = generate_seq(&mut rand, &schema);
        seq.is_valid();

        if seq.seq().len() >= 2 {
            let idx = rand.between(0, seq.seq().len() - 1);
            seq.remove(idx);

            seq.complete(&mut rand, &schema).expect("complete failed");
            seq.is_valid();
        }
    }

    Ok(())
}

#[test]
fn composition_shift_then_complete() -> Result<()> {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");

    for seed in 0..100 {
        let mut rand = StdRand::with_seed(seed);
        let mut seq = generate_seq(&mut rand, &schema);
        seq.is_valid();

        seq.shift();

        seq.complete(&mut rand, &schema).expect("complete failed");
        seq.is_valid();
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Fuzz buffer independence
// ---------------------------------------------------------------------------

#[test]
fn fuzz_buffer_independence() {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");

    for seed in 0..50 {
        let mut rand_a = StdRand::with_seed(seed);
        let fuzz_a: Vec<u8> = vec![0; 64];
        let seq_a = ApiSeq::create(&mut rand_a, &schema, fuzz_a).expect("create failed");
        seq_a.is_valid();

        let mut rand_b = StdRand::with_seed(seed);
        let fuzz_b: Vec<u8> = vec![255; 64];
        let seq_b = ApiSeq::create(&mut rand_b, &schema, fuzz_b).expect("create failed");
        seq_b.is_valid();

        assert_eq!(seq_a.seq().len(), seq_b.seq().len(),
            "different fuzz buffers should not affect sequence structure for seed {seed}");

        for (ca, cb) in seq_a.seq().iter().zip(seq_b.seq().iter()) {
            assert_eq!(ca.name, cb.name,
                "different fuzz buffers should not affect call names for seed {seed}");
        }
    }
}

#[test]
fn fuzz_buffer_empty() {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");
    let mut rand = StdRand::with_seed(42);
    let seq = ApiSeq::create(&mut rand, &schema, vec![]).expect("create with empty fuzz failed");
    seq.is_valid();
}

#[test]
fn fuzz_buffer_large() {
    let schema = load_schema("tests/common/jpeg-js-typescript.json");
    let mut rand = StdRand::with_seed(42);
    let fuzz: Vec<u8> = (0..8192).map(|i| (i % 256) as u8).collect();
    let seq = ApiSeq::create(&mut rand, &schema, fuzz).expect("create with large fuzz failed");
    seq.is_valid();
}
