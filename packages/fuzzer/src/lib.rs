use anyhow::Result;
use std::{num::NonZero, path::PathBuf, time::Duration};

use clap::ValueEnum;
use libafl::{
    corpus::{CachedOnDiskCorpus, Corpus, InMemoryCorpus, OnDiskCorpus},
    events::{EventConfig, Launcher, LlmpRestartingEventManager, SendExiting},
    executors::InProcessExecutor,
    inputs::HasTargetBytes,
    monitors::Monitor,
    mutators::{LoggerScheduledMutator, SingleChoiceScheduledMutator},
    stages::StdMutationalStage,
    state::{HasCorpus, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{
    core_affinity::Cores,
    rands::StdRand,
    shmem::{ShMemProvider, StdShMem, StdShMemProvider},
    tuples::tuple_list,
};
use serde::{Deserialize, Serialize};

pub mod bytes;
pub mod feedback;
pub mod metrics;
pub mod monitor;
pub mod mutations;
pub mod observer;
pub mod rng;
pub mod scheduler;
pub mod schema;
pub mod seq;
pub mod shmem;
pub mod worker;

pub use worker::Worker;

use crate::{
    feedback::{StdFeedback, UniqCrashFeedback},
    mutations::sequence_mutations,
    observer::make_observers,
    scheduler::StdScheduler,
    seq::{ApiSeq, ApiSeqGenerator},
};

pub type State<I> = StdState<CachedOnDiskCorpus<I>, I, StdRand, OnDiskCorpus<I>>;
pub type RestartingManager<I> =
    LlmpRestartingEventManager<(), I, State<I>, StdShMem, StdShMemProvider>;

pub type ReplayState<I> = StdState<InMemoryCorpus<I>, I, StdRand, InMemoryCorpus<I>>;
pub type ReplayRestartingManager<I, SP> =
    LlmpRestartingEventManager<(), I, ReplayState<I>, <SP as ShMemProvider>::ShMem, SP>;

const CORPUS_CACHE_SIZE: usize = 512;
const INITIAL_CORPUS_SIZE: usize = 32;
const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();
const MIN_INPUT_LENGTH: NonZero<usize> = NonZero::new(8).unwrap();

#[derive(ValueEnum, Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FuzzerMode {
    Bytes,
    Sequence,
}

#[derive(Serialize, Deserialize)]
pub struct FuzzerConfig {
    pub port: u16,
    pub mode: FuzzerMode,
    pub timeout: Duration,
    pub corpus: PathBuf,
    pub crashes: PathBuf,
    pub metrics: PathBuf,
    pub seed: u64,
    pub entrypoint: PathBuf,
    pub schema_file: Option<PathBuf>,
    pub replay: bool,
    pub replay_input: Option<PathBuf>,
    pub config_file: Option<PathBuf>,
    pub cores: Cores,
    pub labels: Vec<String>,
    pub iterations: Option<u64>,
    pub debug_dump_schema: Option<PathBuf>,
}

impl FuzzerConfig {
    #[inline]
    pub fn is_replay(&self) -> bool {
        self.replay_input.is_some() || self.replay
    }
}

fn client(
    state: Option<State<ApiSeq>>,
    mut manager: RestartingManager<ApiSeq>,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    let mut feedback = StdFeedback::new(false, &observers);
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
    let mut generator = ApiSeqGenerator::new(&schema, MIN_INPUT_LENGTH, MAX_INPUT_LENGTH);

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

    let mut stages = tuple_list!(StdMutationalStage::new(LoggerScheduledMutator::new(
        SingleChoiceScheduledMutator::new(sequence_mutations(&schema))
    )));

    if let Some(iters) = config.iterations {
        // NOTE: Sometimes I pass 0 here in case I only want to test fuzzer startup code
        // (like for schema inference or seed generation). LibAFL does not like that, so
        // don't try to fuzz if iterations is 0.
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

pub fn launch_seq_fuzzer<M>(
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
