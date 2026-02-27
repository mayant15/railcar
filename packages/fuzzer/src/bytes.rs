use std::num::NonZero;

use anyhow::Result;
use libafl::{
    corpus::{CachedOnDiskCorpus, Corpus, OnDiskCorpus},
    events::{EventConfig, Launcher},
    executors::InProcessExecutor,
    generators::RandBytesGenerator,
    inputs::{BytesInput, HasTargetBytes},
    monitors::Monitor,
    mutators::{havoc_mutations, HavocScheduledMutator},
    schedulers::StdWeightedScheduler,
    stages::StdMutationalStage,
    state::{HasCorpus, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{
    core_affinity::Cores, rands::StdRand, shmem::StdShMemProvider, tuples::tuple_list,
};

use crate::{
    feedback::{StdFeedback, UniqCrashFeedback},
    observer::make_observers,
    FuzzerConfig, RestartingManager, State, Worker,
};

const CORPUS_CACHE_SIZE: usize = 512;
const INITIAL_CORPUS_SIZE: usize = 32;
const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();

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
    state: Option<State<BytesInput>>,
    mut manager: RestartingManager<BytesInput>,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    // we don't want coverage feedback but we still want to count valid execution stats
    let mut feedback = StdFeedback::new(false, &observers);
    let mut objective = UniqCrashFeedback::new(&observers);

    let mut state = state.unwrap_or_else(|| {
        StdState::new(
            StdRand::with_seed(config.seed),
            CachedOnDiskCorpus::no_meta(config.corpus.clone(), CORPUS_CACHE_SIZE).unwrap(),
            OnDiskCorpus::new(config.crashes.clone()).unwrap(),
            &mut feedback,
            &mut objective,
        )
        .expect("failed to create state")
    });

    let scheduler = StdWeightedScheduler::new(&mut state, coverage);
    let mut generator = RandBytesGenerator::new(MAX_INPUT_LENGTH);

    let mut fuzzer = StdFuzzer::new(scheduler, feedback, objective);

    let mut harness = |input: &BytesInput| {
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

    let mut stages = tuple_list!(StdMutationalStage::new(HavocScheduledMutator::new(
        havoc_mutations()
    )),);

    fuzzer.fuzz_loop(&mut stages, &mut executor, &mut state, &mut manager)?;

    Ok(())
}
