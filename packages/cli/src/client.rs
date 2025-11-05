#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{path::PathBuf, time::Duration};

use anyhow::{bail, Result};
use clap::ValueEnum;
use libafl::{
    corpus::{CachedOnDiskCorpus, Corpus, InMemoryCorpus, OnDiskCorpus},
    events::{LlmpRestartingEventManager, SendExiting},
    executors::{ExitKind, InProcessExecutor},
    feedbacks::{ConstFeedback, Feedback},
    generators::{Generator, RandBytesGenerator},
    inputs::{BytesInput, HasMutatorBytes, Input},
    mutators::Mutator,
    observers::ObserversTuple,
    schedulers::QueueScheduler,
    stages::StdMutationalStage,
    state::{HasCorpus, HasRand, StdState},
    Fuzzer, StdFuzzer,
};
use libafl_bolts::{
    rands::StdRand,
    shmem::{MmapShMem, MmapShMemProvider, ShMemProvider},
    tuples::tuple_list,
};
use railcar_graph::{Graph, HasSchema, ParametricGraph, RailcarError, Schema};
use serde::{Deserialize, Serialize};

use crate::{
    config::{INITIAL_CORPUS_SIZE, MAX_INPUT_LENGTH, MIN_INPUT_LENGTH},
    feedback::set_valid,
    worker::{Worker, WorkerArgs},
};

pub type State<I> = StdState<CachedOnDiskCorpus<I>, I, StdRand, OnDiskCorpus<I>>;
pub type RestartingManager<I> =
    LlmpRestartingEventManager<(), I, State<I>, MmapShMem, MmapShMemProvider>;

type ReplayState<I> = StdState<InMemoryCorpus<I>, I, StdRand, InMemoryCorpus<I>>;
type ReplayRestartingManager<I, SP> =
    LlmpRestartingEventManager<(), I, ReplayState<I>, <SP as ShMemProvider>::ShMem, SP>;

#[derive(ValueEnum, Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FuzzerMode {
    Bytes,
    Graph,
    Parametric,
}

pub struct FuzzerConfig {
    pub port: u16,
    pub mode: FuzzerMode,
    pub timeout: Duration,
    pub corpus: PathBuf,
    pub crashes: PathBuf,
    pub seed: u64,
    pub entrypoint: PathBuf,
    pub schema_file: Option<PathBuf>,
    pub simple_mutations: bool,
    pub replay: bool,
    pub use_validity: bool,
    pub replay_input: Option<String>,
    pub config_file: PathBuf,
}

struct GraphGenerator<'a> {
    schema: &'a Schema,
}

impl<'a> GraphGenerator<'a> {
    fn new(schema: &'a Schema) -> Self {
        Self { schema }
    }
}

impl<S: HasRand> Generator<Graph, S> for GraphGenerator<'_> {
    fn generate(&mut self, state: &mut S) -> Result<Graph, libafl::Error> {
        match Graph::create(state.rand_mut(), self.schema) {
            Ok(graph) => Ok(graph),
            Err(e) => match e {
                RailcarError::HugeGraph => {
                    Graph::create_small(state.rand_mut(), self.schema).map_err(|e| e.into())
                }
                RailcarError::Unknown(msg) => Err(libafl::Error::unknown(msg)),
            },
        }
    }
}

struct ParametricGenerator<'a> {
    schema: &'a Schema,
    bytes_gen: RandBytesGenerator,
}

impl<'a> ParametricGenerator<'a> {
    fn new(schema: &'a Schema) -> Self {
        Self {
            schema,
            bytes_gen: RandBytesGenerator::with_min_size(MIN_INPUT_LENGTH, MAX_INPUT_LENGTH),
        }
    }
}

impl<S: HasRand> Generator<ParametricGraph, S> for ParametricGenerator<'_> {
    fn generate(&mut self, state: &mut S) -> Result<ParametricGraph, libafl::Error> {
        let bytes = self.bytes_gen.generate(state)?;
        Ok(ParametricGraph::new(self.schema.clone(), bytes.into()))
    }
}

// NOTE: this should stay in sync with worker/common.ts
fn handle_exit_code(code: u8) -> ExitKind {
    match code {
        0 => {
            set_valid(true);
            ExitKind::Ok
        }
        1 => {
            // was an expected error
            set_valid(false);
            ExitKind::Ok // don't save expected crashes to crashes dir
        }
        3 => {
            panic!("fuzzer requested an abort for input");
        }
        _ => {
            set_valid(true);
            ExitKind::Crash
        }
    }
}

pub trait ToFuzzerInput: Input {
    fn to_fuzzer_input(&self, config: &FuzzerConfig) -> Result<Vec<u8>>;
}

impl ToFuzzerInput for BytesInput {
    fn to_fuzzer_input(&self, _: &FuzzerConfig) -> Result<Vec<u8>> {
        Ok(self.mutator_bytes().to_vec())
    }
}

impl ToFuzzerInput for ParametricGraph {
    fn to_fuzzer_input(&self, config: &FuzzerConfig) -> Result<Vec<u8>> {
        let graph = match Graph::create_from_bytes(config.seed, self.mutator_bytes(), self.schema())
        {
            Ok(graph) => graph,
            Err(e) => {
                bail!("failed to create graph from bytes {}", e);
            }
        };

        let bytes = match rmp_serde::to_vec_named(&graph) {
            Ok(bytes) => bytes,
            Err(e) => {
                bail!("failed to create bytes from graph {}", e);
            }
        };

        Ok(bytes)
    }
}

impl ToFuzzerInput for Graph {
    fn to_fuzzer_input(&self, config: &FuzzerConfig) -> Result<Vec<u8>> {
        if !matches!(config.mode, FuzzerMode::Graph) {
            bail!("graph inputs need FuzzerMode::Graph");
        }

        let bytes = match rmp_serde::to_vec_named(self) {
            Ok(bytes) => bytes,
            Err(e) => {
                bail!("failed to create bytes from graph {}", e);
            }
        };

        Ok(bytes)
    }
}

impl From<&FuzzerConfig> for WorkerArgs {
    fn from(config: &FuzzerConfig) -> Self {
        WorkerArgs {
            mode: config.mode.clone(),
            entrypoint: config.entrypoint.clone(),
            schema_file: config.schema_file.clone(),
            replay: config.replay,
            config_file: config.config_file.clone(),
        }
    }
}

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

    let mut executor = InProcessExecutor::batched_timeout(
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
        set_valid(true); // assume an input is valid unless we learn otherwise

        let Ok(bytes) = input.to_fuzzer_input(args.config) else {
            // discard these inputs
            return ExitKind::Ok;
        };

        let code = match args.worker.invoke(&bytes) {
            Ok(code) => code,
            Err(e) => panic!("failed to invoke worker {}", e),
        };

        handle_exit_code(code)
    };

    let mut executor = InProcessExecutor::batched_timeout(
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
    use crate::{
        config::{CORPUS_CACHE_SIZE, MAX_INPUT_LENGTH},
        feedback::{coverage_observer, StdFeedback, UniqCrashFeedback},
        worker::Worker,
    };

    use super::{launch_fuzzer, FuzzerConfig, FuzzerLaunchArgs, RestartingManager, State};
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        generators::RandBytesGenerator,
        inputs::BytesInput,
        mutators::{havoc_mutations, StdScheduledMutator},
        schedulers::StdWeightedScheduler,
        state::StdState,
    };
    use libafl_bolts::{rands::StdRand, tuples::tuple_list};

    pub fn start(
        state: Option<State<BytesInput>>,
        restarting_mgr: RestartingManager<BytesInput>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let coverage_map = coverage_observer(
            worker
                .coverage_mut()
                .expect("must init coverage map for fuzzing"),
        );

        // we don't want coverage feedback but we still want to count valid execution stats
        let mut feedback = StdFeedback::new(&coverage_map, config.use_validity);
        let mut objective = UniqCrashFeedback::new(&coverage_map);

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

        let scheduler = StdWeightedScheduler::new(&mut state, &coverage_map);
        let generator = RandBytesGenerator::new(MAX_INPUT_LENGTH);

        launch_fuzzer(FuzzerLaunchArgs {
            config,
            observers: tuple_list!(coverage_map),
            feedback,
            objective,
            scheduler,
            mutator: StdScheduledMutator::new(havoc_mutations()),
            generator,
            state,
            worker,
            manager: restarting_mgr,
        })
    }
}

pub mod parametric {
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        mutators::StdScheduledMutator,
        state::StdState,
    };
    use libafl_bolts::{rands::StdRand, tuples::tuple_list};
    use railcar_graph::ParametricGraph;

    use crate::{
        config::CORPUS_CACHE_SIZE,
        feedback::{coverage_observer, validity_observer, StdFeedback, UniqCrashFeedback},
        mutation::parametric_mutations,
        scheduler::StdScheduler,
        worker::Worker,
    };

    use super::{
        launch_fuzzer, FuzzerConfig, FuzzerLaunchArgs, ParametricGenerator, RestartingManager,
        State,
    };

    pub fn start(
        state: Option<State<ParametricGraph>>,
        restarting_mgr: RestartingManager<ParametricGraph>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let coverage_map = coverage_observer(
            worker
                .coverage_mut()
                .expect("must init coverage map for fuzzing"),
        );
        let (_, validity) = validity_observer();

        let mut feedback = StdFeedback::new(&coverage_map, config.use_validity);
        let mut objective = UniqCrashFeedback::new(&coverage_map);

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

        let scheduler = StdScheduler::new(&mut state, &coverage_map);

        let schema = worker.schema().unwrap().clone();
        let generator = ParametricGenerator::new(&schema);

        launch_fuzzer(FuzzerLaunchArgs {
            config,
            observers: tuple_list!(coverage_map, validity),
            feedback,
            objective,
            scheduler,
            mutator: StdScheduledMutator::new(parametric_mutations()),
            generator,
            state,
            worker,
            manager: restarting_mgr,
        })
    }
}

pub mod graph {
    use anyhow::Result;
    use libafl::{
        corpus::{CachedOnDiskCorpus, OnDiskCorpus},
        state::StdState,
    };
    use libafl_bolts::{rands::StdRand, tuples::tuple_list};
    use railcar_graph::Graph;

    use crate::{
        client::GraphGenerator,
        config::CORPUS_CACHE_SIZE,
        feedback::{coverage_observer, validity_observer, StdFeedback, UniqCrashFeedback},
        mutation::GraphMutator,
        scheduler::StdScheduler,
        worker::Worker,
    };

    use super::{launch_fuzzer, FuzzerConfig, FuzzerLaunchArgs, RestartingManager, State};

    pub fn start(
        state: Option<State<Graph>>,
        restarting_mgr: RestartingManager<Graph>,
        config: &FuzzerConfig,
    ) -> Result<()> {
        let mut worker = Worker::new(config.into())?;

        let coverage_map = coverage_observer(
            worker
                .coverage_mut()
                .expect("must init coverage map for fuzzing"),
        );
        let (_, validity) = validity_observer();

        let mut feedback = StdFeedback::new(&coverage_map, config.use_validity);
        let mut objective = UniqCrashFeedback::new(&coverage_map);

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

        let scheduler = StdScheduler::new(&mut state, &coverage_map);

        let schema = worker.schema().unwrap().clone();
        let generator = GraphGenerator::new(&schema);

        launch_fuzzer(FuzzerLaunchArgs {
            config,
            observers: tuple_list!(coverage_map, validity),
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
