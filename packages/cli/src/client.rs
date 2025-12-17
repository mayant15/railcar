#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::num::NonZero;

use anyhow::Result;
use libafl::{
    corpus::{CachedOnDiskCorpus, Corpus, OnDiskCorpus},
    events::{EventConfig, Launcher},
    executors::{ExitKind, InProcessExecutor},
    feedbacks::Feedback,
    generators::{Generator, RandBytesGenerator},
    inputs::{BytesInput, Input},
    monitors::Monitor,
    mutators::{havoc_mutations, HavocScheduledMutator, Mutator},
    observers::ObserversTuple,
    schedulers::StdWeightedScheduler,
    stages::StdMutationalStage,
    state::{HasCorpus, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{
    core_affinity::Cores, rands::StdRand, shmem::StdShMemProvider, tuples::tuple_list,
};
use railcar::{
    feedback::{StdFeedback, UniqCrashFeedback},
    generators::{GraphGenerator, ParametricGenerator},
    inputs::{Graph, ParametricGraph, ToFuzzerInput},
    mutations::{parametric_mutations, GraphMutator},
    observer::make_observers,
    scheduler::StdScheduler,
    seq, FuzzerConfig, FuzzerMode, RestartingManager, State, Worker,
};
use serde::{Deserialize, Serialize};

pub const CORPUS_CACHE_SIZE: usize = 512;
pub const INITIAL_CORPUS_SIZE: usize = 32;
pub const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();

pub struct FuzzerLaunchArgs<'a, M, F, I, OT, G, SH, OB> {
    pub config: &'a FuzzerConfig,
    pub observers: OT,
    pub feedback: F,
    pub objective: OB,
    pub scheduler: SH,
    pub mutator: M,
    pub generator: G,
    pub state: State<I>,
    pub worker: Worker,
    pub manager: RestartingManager<I>,
}

pub fn start_client_fuzzer<M, F, I, OT, G, SH, OB>(
    mut args: FuzzerLaunchArgs<M, F, I, OT, G, SH, OB>,
) -> Result<()>
where
    I: ToFuzzerInput + Input,
    OT: ObserversTuple<I, State<I>> + Serialize + for<'de> Deserialize<'de>,
    OB: Feedback<RestartingManager<I>, I, OT, State<I>>,
    SH: libafl::schedulers::Scheduler<I, State<I>>,
    F: Feedback<RestartingManager<I>, I, OT, State<I>>,
    G: Generator<I, State<I>>,
    M: Mutator<I, State<I>>,
{
    let mut fuzzer = StdFuzzer::new(args.scheduler, args.feedback, args.objective);

    let mut harness = |input: &I| {
        let Ok(bytes) = input.to_fuzzer_input(args.config) else {
            // discard these inputs
            return ExitKind::Ok;
        };

        args.worker
            .invoke(&bytes)
            .unwrap_or_else(|e| panic!("failed to invoke worker {}", e))
    };

    let mut executor = InProcessExecutor::with_timeout(
        &mut harness,
        args.observers,
        &mut fuzzer,
        &mut args.state,
        &mut args.manager,
        args.config.timeout,
    )?;

    if args.state.must_load_initial_inputs() {
        let corpus = vec![args.config.corpus.clone()];
        args.state
            .load_initial_inputs(&mut fuzzer, &mut executor, &mut args.manager, &corpus)
            .unwrap();
        let count = args.state.corpus().count();
        log::info!("imported {} inputs from disk.", count);
        if count == 0 {
            log::info!("no inputs imported from disk. generating.");
            args.state
                .generate_initial_inputs(
                    &mut fuzzer,
                    &mut executor,
                    &mut args.generator,
                    &mut args.manager,
                    INITIAL_CORPUS_SIZE,
                )
                .expect("failed to generate initial corpus")
        }
    }

    let mut stages = tuple_list!(StdMutationalStage::new(args.mutator));

    fuzzer.fuzz_loop(
        &mut stages,
        &mut executor,
        &mut args.state,
        &mut args.manager,
    )?;
    Ok(())
}

fn bytes_client(
    state: Option<State<BytesInput>>,
    restarting_mgr: RestartingManager<BytesInput>,
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
    let generator = RandBytesGenerator::new(MAX_INPUT_LENGTH);

    start_client_fuzzer(FuzzerLaunchArgs {
        config,
        observers,
        feedback,
        objective,
        scheduler,
        mutator: HavocScheduledMutator::new(havoc_mutations()),
        generator,
        state,
        worker,
        manager: restarting_mgr,
    })
}

fn parametric_client(
    state: Option<State<ParametricGraph>>,
    restarting_mgr: RestartingManager<ParametricGraph>,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    let mut feedback = StdFeedback::new(true, &observers);
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

    let scheduler = StdScheduler::new(&mut state, coverage);

    let schema = worker.schema().unwrap().clone();
    let generator = ParametricGenerator::new(&schema);

    start_client_fuzzer(FuzzerLaunchArgs {
        config,
        observers,
        feedback,
        objective,
        scheduler,
        mutator: HavocScheduledMutator::new(parametric_mutations()),
        generator,
        state,
        worker,
        manager: restarting_mgr,
    })
}

fn graph_client(
    state: Option<State<Graph>>,
    restarting_mgr: RestartingManager<Graph>,
    config: &FuzzerConfig,
) -> Result<()> {
    let mut worker = Worker::new(config.into())?;

    let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
    let coverage = &observers.0;

    let mut feedback = StdFeedback::new(true, &observers);
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

    let scheduler = StdScheduler::new(&mut state, coverage);

    let schema = worker.schema().unwrap().clone();
    let generator = GraphGenerator::new(&schema);

    start_client_fuzzer(FuzzerLaunchArgs {
        config,
        observers,
        feedback,
        objective,
        scheduler,
        mutator: GraphMutator::new(false),
        generator,
        state,
        worker,
        manager: restarting_mgr,
    })
}

fn launch_parent_impl<M, F, I>(
    start: F,
    config: FuzzerConfig,
    shmem_provider: StdShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    M: Monitor + Clone,
    I: ToFuzzerInput,
    F: Fn(Option<State<I>>, RestartingManager<I>, &FuzzerConfig) -> Result<()>,
{
    let mut run_client = |state, restarting_mgr, _| {
        start(state, restarting_mgr, &config).map_err(|e| libafl::Error::unknown(e.to_string()))
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
        FuzzerMode::Bytes => {
            launch_parent_impl(bytes_client, config, shmem_provider, monitor, cores)
        }
        FuzzerMode::Graph => {
            launch_parent_impl(graph_client, config, shmem_provider, monitor, cores)
        }
        FuzzerMode::Parametric => {
            launch_parent_impl(parametric_client, config, shmem_provider, monitor, cores)
        }
        FuzzerMode::Sequence => seq::launch(config, shmem_provider, monitor, cores),
    }
}
