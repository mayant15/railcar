use anyhow::Result;
use libafl::{
    corpus::{CachedOnDiskCorpus, OnDiskCorpus},
    events::{ClientDescription, EventConfig, Launcher},
    monitors::Monitor,
    mutators::{havoc_mutations, HavocScheduledMutator},
    state::StdState,
};
use libafl_bolts::{
    core_affinity::Cores, rands::StdRand, shmem::StdShMemProvider, tuples::tuple_list,
};
use railcar::{
    feedback::{StdFeedback, UniqCrashFeedback},
    observer::make_observers,
    scheduler::StdScheduler,
    seq::{ApiSeq, ApiSeqGenerator, ExtendSeq, RemoveSuffixSeq, SpliceSeq},
    FuzzerConfig, FuzzerMode, RestartingManager, Worker,
};

use crate::client::{start_client_fuzzer, FuzzerLaunchArgs};

type Input = ApiSeq;
type State = railcar::State<Input>;

pub const CORPUS_CACHE_SIZE: usize = 512;

pub fn launch<M>(
    config: FuzzerConfig,
    shmem_provider: StdShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    M: Monitor + Clone,
{
    assert_eq!(cores.ids.len(), 2);
    assert!(matches!(config.mode, FuzzerMode::Sequence));

    // TODO: can both processes write to metrics db simultaneously?
    Launcher::builder()
        .configuration(EventConfig::from_name("ensemble"))
        .cores(&cores)
        .monitor(monitor)
        .shmem_provider(shmem_provider)
        .run_client(|s, m, d| {
            run_client(s, m, d, &config).map_err(|e| libafl::Error::illegal_state(format!("{}", e)))
        })
        .broker_port(config.port)
        .build()
        .launch::<Input, State>()?;

    Ok(())
}

fn run_client(
    state: Option<State>,
    manager: RestartingManager<Input>,
    desc: ClientDescription,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    let mut feedback = StdFeedback::new(false, &observers);
    let mut objective = UniqCrashFeedback::new(coverage);

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

    let schema = worker.schema().unwrap().clone();
    let generator = ApiSeqGenerator::new(&schema);
    let scheduler = StdScheduler::new(&mut state, coverage);

    if desc.id() == 0 {
        // API seq searcher
        let mutator = HavocScheduledMutator::new(tuple_list!(
            SpliceSeq { schema: &schema },
            ExtendSeq { schema: &schema },
            RemoveSuffixSeq {},
        ));
        start_client_fuzzer(FuzzerLaunchArgs {
            config,
            observers,
            feedback,
            objective,
            scheduler,
            mutator,
            generator,
            state,
            worker,
            manager,
        })
    } else {
        // Consts searcher
        let mutator = HavocScheduledMutator::new(havoc_mutations());

        // stagger for 5 seconds, let the other fuzzer generate the corpus
        std::thread::sleep(std::time::Duration::from_secs(10));

        start_client_fuzzer(FuzzerLaunchArgs {
            config,
            observers,
            feedback,
            objective,
            scheduler,
            mutator,
            generator,
            state,
            worker,
            manager,
        })
    }
}
