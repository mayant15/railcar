#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::num::NonZero;

use anyhow::Result;
use libafl::{
    corpus::{Corpus, InMemoryCorpus},
    events::SendExiting,
    executors::{ExitKind, InProcessExecutor},
    feedbacks::{ConstFeedback, Feedback},
    generators::Generator,
    inputs::Input,
    mutators::Mutator,
    observers::ObserversTuple,
    schedulers::QueueScheduler,
    stages::StdMutationalStage,
    state::{HasCorpus, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{rands::StdRand, shmem::ShMemProvider, tuples::tuple_list};
use railcar::{
    inputs::ToFuzzerInput, FuzzerConfig, ReplayRestartingManager, ReplayState, RestartingManager,
    State, Worker,
};
use serde::{Deserialize, Serialize};

pub const CORPUS_CACHE_SIZE: usize = 512;
pub const INITIAL_CORPUS_SIZE: usize = 32;
pub const MAX_INPUT_LENGTH: NonZero<usize> = NonZero::new(4096).unwrap();

pub fn replay_input<I: ToFuzzerInput, SP: ShMemProvider>(
    mut restarting_mgr: ReplayRestartingManager<I, SP>,
    config: &FuzzerConfig,
) -> Result<()> {
    let Some(input_path) = &config.replay_input else {
        log::error!("no input file to replay!");
        restarting_mgr.on_shutdown()?;
        return Ok(());
    };

    let input = I::from_file(input_path)?;
    let bytes = input.to_fuzzer_input(config)?;

    let mut worker = Worker::new(config.into())?;
    if let Err(e) = worker.invoke(&bytes) {
        log::error!("failed to invoke worker: {}", e);
    }
    worker.terminate()?;

    restarting_mgr.on_shutdown()?;
    Ok(())
}

pub fn replay<I: ToFuzzerInput, SP: ShMemProvider>(
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

    let mut harness = |input: &I| {
        let mut worker = Worker::new(config.into()).expect("failed to create worker");

        let bytes = match input.to_fuzzer_input(config) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::error!("failed to deserialize replay input: {}", e);
                return ExitKind::Ok;
            }
        };

        if let Err(e) = worker.invoke(&bytes) {
            worker.terminate().expect("failed to terminate worker");
            panic!("failed to invoke worker: {}", e)
        } else {
            worker.terminate().expect("failed to terminate worker");
            ExitKind::Ok
        }
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

    restarting_mgr.on_shutdown()?;
    Ok(())
}

struct FuzzerLaunchArgs<'a, M, F, I, OT, G, SH, OB> {
    config: &'a FuzzerConfig,
    observers: OT,
    feedback: F,
    objective: OB,
    scheduler: SH,
    mutator: M,
    generator: G,
    state: State<I>,
    worker: Worker,
    manager: RestartingManager<I>,
}

fn launch_fuzzer<M, F, I, OT, G, SH, OB>(
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

        let code = match args.worker.invoke(&bytes) {
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

pub mod bytes {
    use super::{launch_fuzzer, FuzzerLaunchArgs, CORPUS_CACHE_SIZE, MAX_INPUT_LENGTH};
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        generators::RandBytesGenerator,
        inputs::BytesInput,
        mutators::{havoc_mutations, HavocScheduledMutator},
        schedulers::StdWeightedScheduler,
        state::StdState,
    };
    use libafl_bolts::rands::StdRand;
    use railcar::{
        feedback::{StdFeedback, UniqCrashFeedback},
        observer::make_observers,
        FuzzerConfig, RestartingManager, State, Worker,
    };

    pub fn start(
        state: Option<State<BytesInput>>,
        restarting_mgr: RestartingManager<BytesInput>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
        let coverage = &observers.0;

        // we don't want coverage feedback but we still want to count valid execution stats
        let mut feedback = StdFeedback::new(config.use_validity, &observers);
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

        let scheduler = StdWeightedScheduler::new(&mut state, coverage);
        let generator = RandBytesGenerator::new(MAX_INPUT_LENGTH);

        launch_fuzzer(FuzzerLaunchArgs {
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
}

pub mod parametric {
    use super::{launch_fuzzer, FuzzerLaunchArgs, CORPUS_CACHE_SIZE};
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        mutators::HavocScheduledMutator,
        state::StdState,
    };
    use libafl_bolts::rands::StdRand;
    use railcar::{
        feedback::{StdFeedback, UniqCrashFeedback},
        generators::ParametricGenerator,
        inputs::ParametricGraph,
        mutations::parametric_mutations,
        observer::make_observers,
        scheduler::StdScheduler,
        worker::Worker,
        FuzzerConfig, RestartingManager, State,
    };

    pub fn start(
        state: Option<State<ParametricGraph>>,
        restarting_mgr: RestartingManager<ParametricGraph>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
        let coverage = &observers.0;

        let mut feedback = StdFeedback::new(config.use_validity, &observers);
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

        let scheduler = StdScheduler::new(&mut state, coverage);

        let schema = worker.schema().unwrap().clone();
        let generator = ParametricGenerator::new(&schema);

        launch_fuzzer(FuzzerLaunchArgs {
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
}

pub mod graph {
    use super::{launch_fuzzer, FuzzerLaunchArgs, CORPUS_CACHE_SIZE};
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        state::StdState,
    };
    use libafl_bolts::rands::StdRand;
    use railcar::{
        feedback::{StdFeedback, UniqCrashFeedback},
        generators::GraphGenerator,
        inputs::Graph,
        mutations::GraphMutator,
        observer::make_observers,
        scheduler::StdScheduler,
        FuzzerConfig, RestartingManager, State, Worker,
    };

    pub fn start(
        state: Option<State<Graph>>,
        restarting_mgr: RestartingManager<Graph>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
        let coverage = &observers.0;

        let mut feedback = StdFeedback::new(config.use_validity, &observers);
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

        let scheduler = StdScheduler::new(&mut state, coverage);

        let schema = worker.schema().unwrap().clone();
        let generator = GraphGenerator::new(&schema);

        launch_fuzzer(FuzzerLaunchArgs {
            config,
            observers,
            feedback,
            objective,
            scheduler,
            mutator: GraphMutator::new(config.simple_mutations),
            generator,
            state,
            worker,
            manager: restarting_mgr,
        })
    }
}

pub mod seq {
    use super::{launch_fuzzer, FuzzerLaunchArgs, CORPUS_CACHE_SIZE};
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        mutators::HavocScheduledMutator,
        state::StdState,
    };
    use libafl_bolts::rands::StdRand;
    use railcar::{
        feedback::{StdFeedback, UniqCrashFeedback},
        generators::ApiSeqGenerator,
        inputs::ApiSeq,
        mutations::sequence_mutations,
        observer::make_observers,
        scheduler::StdScheduler,
        FuzzerConfig, RestartingManager, State, Worker,
    };

    pub fn start(
        state: Option<State<ApiSeq>>,
        restarting_mgr: RestartingManager<ApiSeq>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let observers = make_observers(worker.shmem_mut().expect("must init shmem for fuzzing"));
        let coverage = &observers.0;

        let mut feedback = StdFeedback::new(config.use_validity, &observers);
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

        let scheduler = StdScheduler::new(&mut state, coverage);

        let schema = worker.schema().unwrap().clone();
        let generator = ApiSeqGenerator::new(&schema);

        launch_fuzzer(FuzzerLaunchArgs {
            config,
            observers,
            feedback,
            objective,
            scheduler,
            mutator: HavocScheduledMutator::new(sequence_mutations(&schema)),
            generator,
            state,
            worker,
            manager: restarting_mgr,
        })
    }
}
