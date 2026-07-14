//! Single API calls.
//!
//! This fuzzer constructs `ApiSeq` of length 1, with constant arguments
//! (via the data provider API).

use std::num::NonZeroUsize;

use crate::{
    feedback::{StdFeedback, UniqCrashFeedback},
    mutations::ConstTypes,
    observer::make_observers,
    scheduler::StdScheduler,
    schema::Schema,
    seq::ApiSeq,
    FuzzerConfig, FuzzerMode, RestartingManager, State, Worker, CORPUS_CACHE_SIZE,
    INITIAL_CORPUS_SIZE, MAX_INPUT_LENGTH, MIN_INPUT_LENGTH,
};
use anyhow::Result;
use libafl::{
    corpus::{CachedOnDiskCorpus, Corpus, OnDiskCorpus},
    events::{EventConfig, Launcher, SendExiting},
    executors::InProcessExecutor,
    generators::{Generator, RandBytesGenerator},
    inputs::HasTargetBytes,
    monitors::Monitor,
    mutators::{havoc_mutations, HavocScheduledMutator, SingleChoiceScheduledMutator},
    stages::StdMutationalStage,
    state::{HasCorpus, HasRand, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{
    core_affinity::Cores, rands::StdRand, shmem::StdShMemProvider, tuples::tuple_list,
};

pub fn launch<M>(
    config: FuzzerConfig,
    shmem_provider: StdShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    M: Monitor + Clone,
{
    Launcher::builder()
        .configuration(EventConfig::from_name("default"))
        .shmem_provider(shmem_provider)
        .monitor(monitor)
        .cores(&cores)
        .run_client(|state, mgr, _| {
            client(state, mgr, &config).map_err(|e| libafl::Error::unknown(e.to_string()))
        })
        .broker_port(config.port)
        .build()
        .launch()?;
    Ok(())
}

fn client(
    state: Option<State<ApiSeq>>,
    mut manager: RestartingManager<ApiSeq>,
    config: &FuzzerConfig,
) -> Result<()> {
    assert!(matches!(config.mode, FuzzerMode::Single));

    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    let mut feedback = StdFeedback::new(&observers);
    let mut objective = UniqCrashFeedback::new(&observers);

    let mut state = state.unwrap_or_else(|| {
        StdState::new(
            StdRand::with_seed(config.seed),
            CachedOnDiskCorpus::new(config.corpus.clone(), CORPUS_CACHE_SIZE).unwrap(),
            OnDiskCorpus::new(config.crashes.clone()).unwrap(),
            &mut feedback,
            &mut objective,
        )
        .expect("failed to create state")
    });

    let scheduler = StdScheduler::new(&mut state, coverage);

    let schema = worker.schema().unwrap().clone();
    let mut generator = SingleApiSeqGenerator::new(&schema, MIN_INPUT_LENGTH, MAX_INPUT_LENGTH);

    let mut fuzzer = StdFuzzer::new(scheduler, feedback, objective);

    let mut harness = |input: &ApiSeq| {
        let bytes = input.target_bytes();
        worker
            .invoke(&bytes)
            .unwrap_or_else(|e| panic!("failed to invoke worker {}", e))
    };

    let mut executor = InProcessExecutor::with_timeout(
        &mut harness,
        observers,
        &mut fuzzer,
        &mut state,
        &mut manager,
        config.timeout,
    )?;

    if state.must_load_initial_inputs() {
        let corpus = vec![config.corpus.clone()];
        state
            .load_initial_inputs(&mut fuzzer, &mut executor, &mut manager, &corpus)
            .unwrap();
        let count = state.corpus().count();
        log::info!("imported {} inputs from disk.", count);
        if count == 0 {
            log::info!("no inputs imported from disk. generating.");
            state
                .generate_initial_inputs(
                    &mut fuzzer,
                    &mut executor,
                    &mut generator,
                    &mut manager,
                    INITIAL_CORPUS_SIZE,
                )
                .expect("failed to generate initial corpus")
        }
    }

    let mut stages = tuple_list!(StdMutationalStage::new(SingleChoiceScheduledMutator::new(
        tuple_list!(
            ConstTypes { schema: &schema },
            HavocScheduledMutator::new(havoc_mutations()),
        )
    )));

    if let Some(iters) = config.iterations {
        // NOTE: Sometimes I pass 0 here in case I only want to test fuzzer startup code
        // (like for schema inference or seed generation). LibAFL does not like that, so
        // don't try to fuzz if iterations is 0.
        //
        // See lib.rs
        if iters > 0 {
            fuzzer.fuzz_loop_for(&mut stages, &mut executor, &mut state, &mut manager, iters)?;
        }
        worker.terminate()?;
        manager.on_shutdown()?;
    } else {
        fuzzer.fuzz_loop(&mut stages, &mut executor, &mut state, &mut manager)?;
    }

    Ok(())
}

pub struct SingleApiSeqGenerator<'a> {
    schema: &'a Schema,
    bytes_gen: RandBytesGenerator,
}

impl<'a> SingleApiSeqGenerator<'a> {
    pub fn new(schema: &'a Schema, min_size: NonZeroUsize, max_size: NonZeroUsize) -> Self {
        Self {
            schema,
            bytes_gen: RandBytesGenerator::with_min_size(min_size, max_size),
        }
    }
}

impl<S: HasRand> Generator<ApiSeq, S> for SingleApiSeqGenerator<'_> {
    fn generate(&mut self, state: &mut S) -> Result<ApiSeq, libafl::Error> {
        let bytes = self.bytes_gen.generate(state)?;
        ApiSeq::create_single(state.rand_mut(), self.schema, bytes.into())
            .map_err(|e| libafl::Error::unknown(format!("failed to generate an api call: {}", e)))
    }
}
