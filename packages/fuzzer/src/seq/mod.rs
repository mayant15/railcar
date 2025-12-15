use std::num::NonZero;

use anyhow::Result;
use libafl::{
    corpus::{CachedOnDiskCorpus, Corpus, OnDiskCorpus},
    events::{EventConfig, Launcher},
    executors::{ExitKind, InProcessExecutor},
    generators::{Generator, RandBytesGenerator},
    monitors::Monitor,
    mutators::{LoggerScheduledMutator, SingleChoiceScheduledMutator},
    stages::StdMutationalStage,
    state::{HasCorpus, HasRand, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{
    core_affinity::Cores, rands::StdRand, shmem::StdShMemProvider, tuples::tuple_list,
};

use crate::{
    feedback::{StdFeedback, UniqCrashFeedback},
    inputs::ToFuzzerInput,
    observer::make_observers,
    scheduler::StdScheduler,
    schema::Schema,
    seq::mutations::sequence_mutations,
    FuzzerConfig, RestartingManager, State, Worker,
};

mod input;
mod mutations;

pub use input::ApiSeq;
pub use mutations::{ExtendSeq, RemovePrefixSeq, RemoveSuffixSeq, SpliceSeq};

pub const CORPUS_CACHE_SIZE: usize = 512;
pub const INITIAL_CORPUS_SIZE: usize = 32;
pub const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();
pub const MIN_INPUT_LENGTH: NonZero<usize> = NonZero::new(8).unwrap();

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

fn client(
    state: Option<State<ApiSeq>>,
    mut manager: RestartingManager<ApiSeq>,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    let mut objective = UniqCrashFeedback::new(coverage);
    let mut feedback = StdFeedback::new(false, &observers);

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
    let mut generator = ApiSeqGenerator::new(&schema);

    let mut fuzzer = StdFuzzer::new(scheduler, feedback, objective);

    let mut harness = |input: &ApiSeq| {
        let Ok(bytes) = input.to_fuzzer_input(config) else {
            // discard these inputs
            return ExitKind::Ok;
        };

        let code = match worker.invoke(&bytes) {
            Ok(code) => code,
            Err(e) => panic!("failed to invoke worker {}", e),
        };

        // From worker/common.ts
        match code {
            0 | 1 => ExitKind::Ok,
            2 => ExitKind::Crash,
            _ => unreachable!(),
        }
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

    fuzzer.fuzz_loop(&mut stages, &mut executor, &mut state, &mut manager)?;
    Ok(())
}

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
