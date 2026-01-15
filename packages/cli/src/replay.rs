use anyhow::Result;
use libafl::{
    corpus::{Corpus, InMemoryCorpus},
    events::{EventConfig, Launcher, SendExiting},
    executors::{ExitKind, InProcessExecutor},
    feedbacks::ConstFeedback,
    inputs::BytesInput,
    monitors::Monitor,
    schedulers::QueueScheduler,
    state::{HasCorpus, StdState},
    StdFuzzer,
};
use libafl_bolts::{
    core_affinity::Cores,
    rands::StdRand,
    shmem::{ShMemProvider, StdShMemProvider},
    tuples::tuple_list,
};
use railcar::{
    inputs::{Graph, ParametricGraph, ToFuzzerInput},
    seq::ApiSeq,
    FuzzerConfig, FuzzerMode, ReplayRestartingManager, ReplayState, Worker,
};

fn client<I: ToFuzzerInput, SP: ShMemProvider>(
    state: Option<ReplayState<I>>,
    mut restarting_mgr: ReplayRestartingManager<I, SP>,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut feedback = ConstFeedback::new(true);
    let mut objective = ConstFeedback::new(false);

    let mut state = state.unwrap_or_else(|| {
        StdState::new(
            StdRand::with_seed(config.seed),
            InMemoryCorpus::new(),
            InMemoryCorpus::new(),
            &mut feedback,
            &mut objective,
        )
        .expect("failed to create state")
    });

    let scheduler = QueueScheduler::new();

    let mut worker = Worker::new(config.into())?;

    let mut harness = |input: &I| {
        let bytes = match input.to_fuzzer_input(config) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::error!("failed to deserialize replay input: {}", e);
                return ExitKind::Ok;
            }
        };

        if let Err(e) = worker.invoke(&bytes) {
            panic!("failed to invoke worker: {}", e);
        }

        ExitKind::Ok
    };

    let mut fuzzer = StdFuzzer::new(scheduler, feedback, objective);

    let mut executor = InProcessExecutor::with_timeout(
        &mut harness,
        tuple_list!(),
        &mut fuzzer,
        &mut state,
        &mut restarting_mgr,
        config.timeout,
    )?;

    state.load_initial_inputs(
        &mut fuzzer,
        &mut executor,
        &mut restarting_mgr,
        std::slice::from_ref(&config.corpus),
    )?;
    log::info!("Replayed {} inputs", state.corpus().count());

    worker.terminate()?;

    restarting_mgr.on_shutdown()?;
    Ok(())
}

fn launch_impl<I, M>(
    config: FuzzerConfig,
    shmem_provider: StdShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    I: ToFuzzerInput,
    M: Monitor + Clone,
{
    let mut run_client = |state, restarting_mgr, _| {
        client::<I, _>(state, restarting_mgr, &config)
            .map_err(|e| libafl::Error::unknown(e.to_string()))
    };

    Launcher::builder()
        .configuration(EventConfig::from_name("default"))
        .shmem_provider(shmem_provider)
        .monitor(monitor)
        .cores(&cores)
        .run_client(&mut run_client)
        .broker_port(config.port)
        .build()
        .launch()?;

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
    match config.mode {
        FuzzerMode::Bytes => launch_impl::<BytesInput, _>(config, shmem_provider, monitor, cores),
        FuzzerMode::Graph => launch_impl::<Graph, _>(config, shmem_provider, monitor, cores),
        FuzzerMode::Parametric => {
            launch_impl::<ParametricGraph, _>(config, shmem_provider, monitor, cores)
        }
        FuzzerMode::Sequence => launch_impl::<ApiSeq, _>(config, shmem_provider, monitor, cores),
    }
}
