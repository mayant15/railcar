use std::{path::PathBuf, time::Duration};

use clap::ValueEnum;
use libafl::{
    corpus::{CachedOnDiskCorpus, InMemoryCorpus, OnDiskCorpus},
    events::LlmpRestartingEventManager,
    state::StdState,
};
use libafl_bolts::{
    core_affinity::Cores,
    rands::StdRand,
    shmem::{MmapShMem, MmapShMemProvider, ShMemProvider},
};
use serde::{Deserialize, Serialize};

pub mod feedback;
pub mod generators;
pub mod inputs;
pub mod metrics;
pub mod monitor;
pub mod mutations;
pub mod observer;
pub mod rng;
pub mod scheduler;
pub mod schema;
pub mod shmem;
pub mod worker;

mod config;

pub use worker::Worker;

pub type State<I> = StdState<CachedOnDiskCorpus<I>, I, StdRand, OnDiskCorpus<I>>;
pub type RestartingManager<I> =
    LlmpRestartingEventManager<(), I, State<I>, MmapShMem, MmapShMemProvider>;

pub type ReplayState<I> = StdState<InMemoryCorpus<I>, I, StdRand, InMemoryCorpus<I>>;
pub type ReplayRestartingManager<I, SP> =
    LlmpRestartingEventManager<(), I, ReplayState<I>, <SP as ShMemProvider>::ShMem, SP>;

#[derive(ValueEnum, Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FuzzerMode {
    Bytes,
    Graph,
    Parametric,
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
    pub simple_mutations: bool,
    pub replay: bool,
    pub use_validity: bool,
    pub replay_input: Option<String>,
    pub config_file: Option<PathBuf>,
    pub cores: Cores,
    pub labels: Vec<String>,
}
