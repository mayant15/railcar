// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{path::PathBuf, str::FromStr, time::Duration};

use anyhow::Result;
use clap::Parser;
use client::{FuzzerConfig, FuzzerMode, RestartingManager, State, ToFuzzerInput};
use config::METRICS_BUFFER_SIZE;
use libafl::{
    events::{EventConfig, Launcher},
    inputs::BytesInput,
    monitors::Monitor,
};
use libafl_bolts::{
    core_affinity::Cores,
    shmem::{MmapShMemProvider, ShMemProvider},
};
use monitor::create_monitor;
use railcar_graph::{Graph, ParametricGraph};

mod client;
mod config;
mod events;
mod feedback;
mod monitor;
mod mutation;
mod scheduler;
mod worker;

/// Fuzzer for JavaScript libraries with automatic fuzz drivers
#[derive(Parser)]
#[command(version)]
struct Arguments {
    /// Entrypoint for the library to test for graph and parametric drivers.
    /// File that exports a `fuzz` function for bytes driver.
    entrypoint: String,

    /// Only replay the corpus. Use this with `nyc` to report coverage
    #[arg(long, default_value_t = false)]
    replay: bool,

    /// Replay a single input
    #[arg(long)]
    replay_input: Option<String>,

    /// Per-testcase timeout in seconds
    #[arg(long, default_value_t = 5)]
    timeout: u64,

    /// Corpus directory
    #[arg(long, default_value_t = String::from_str("corpus").unwrap())]
    corpus: String,

    /// Crashes directory
    #[arg(long, default_value_t = String::from_str("crashes").unwrap())]
    crashes: String,

    /// Fuzz driver variant to use
    #[arg(long, value_enum, default_value_t = FuzzerMode::Bytes)]
    mode: FuzzerMode,

    /// Port to spawn the IPC broker on. If spawning multiple instances they should have different
    /// ports.
    #[arg(long, default_value_t = 1337)]
    port: u16,

    /// Seed for the random number generator for deterministic execution
    #[arg(long)]
    seed: Option<u64>,

    /// Cores to run on. Comma-separated numbers and ranges, like "1,2-4,6" or "all"
    #[arg(long, default_value_t = String::from_str("1").unwrap())]
    cores: String,

    /// Error messages to ignore. Used as feedback to the fuzzer instead
    #[arg(short, long)]
    ignore: Option<Vec<String>>,

    /// Library endpoints to exclude from fuzzing
    #[arg(short, long)]
    skip_endpoints: Option<Vec<String>>,

    /// Path to a schema file for the target library. Will be inferred at run-time otherwise
    #[arg(long)]
    schema: Option<String>,

    /// Path to log fuzzer metrics
    #[arg(long)]
    metrics: Option<String>,

    /// Use simple mutations when using the graph driver
    #[arg(long, default_value_t = false)]
    simple_mutations: bool,

    /// Use validity feedback. Enabled by default for graph and parametric drivers. Disabled by
    /// default for bytes driver.
    #[arg(long)]
    use_validity: Option<bool>,
}

fn to_absolute(path: String) -> PathBuf {
    let path = PathBuf::from_str(path.as_str()).unwrap();
    if path.is_absolute() {
        path
    } else {
        let cwd = std::env::current_dir().unwrap();
        cwd.join(path)
    }
}

fn launch_replay_input<I, M>(
    config: FuzzerConfig,
    shmem_provider: MmapShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    I: ToFuzzerInput,
    M: Monitor + Clone,
{
    log::info!("[*] starting replay for input");
    log::info!("       input: {:?}", config.replay_input);
    log::info!("      target: {:?}", config.entrypoint);
    log::info!("      driver: {:?}", config.mode);
    log::info!("      schema: {:?}", config.schema_file);
    log::info!("      simple: {}", config.simple_mutations);
    log::info!("        seed: {}", config.seed);

    let mut run_client = |_, restarting_mgr, _| {
        client::replay_input::<I, _>(restarting_mgr, &config)
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

fn launch_replay<I, M>(
    config: FuzzerConfig,
    shmem_provider: MmapShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    I: ToFuzzerInput,
    M: Monitor + Clone,
{
    log::info!("[*] starting replay");
    log::info!("      target: {:?}", config.entrypoint);
    log::info!("      driver: {:?}", config.mode);
    log::info!("      schema: {:?}", config.schema_file);
    log::info!("      simple: {}", config.simple_mutations);
    log::info!("        seed: {}", config.seed);

    let mut run_client = |state, restarting_mgr, _| {
        client::replay::<I, _>(state, restarting_mgr, &config)
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

fn launch_fuzzer<M, F, I>(
    start: F,
    config: FuzzerConfig,
    shmem_provider: MmapShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    M: Monitor + Clone,
    I: ToFuzzerInput,
    F: Fn(Option<State<I>>, RestartingManager<I>, &FuzzerConfig) -> Result<()>,
{
    log::info!("[*] starting fuzzer");
    log::info!("      target: {:?}", config.entrypoint);
    log::info!("      driver: {:?}", config.mode);
    log::info!("      schema: {:?}", config.schema_file);
    log::info!("      simple: {}", config.simple_mutations);
    log::info!("        seed: {}", config.seed);

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

fn main() -> Result<()> {
    env_logger::builder()
        .filter(None, log::LevelFilter::Warn)
        .filter(
            Some("railcar_cli"),
            if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            },
        )
        .init();

    let args = Arguments::parse();

    // write to a temporary file if no user-provided path
    let metrics = args.metrics.unwrap_or_else(|| {
        let temp_dir = std::env::temp_dir();
        let metrics = temp_dir.join("railcar-metrics.json");
        std::fs::write(&metrics, b"").unwrap();
        metrics.into_os_string().into_string().unwrap()
    });
    metrics::init(metrics.as_str(), Some(METRICS_BUFFER_SIZE));

    let config = client::FuzzerConfig {
        mode: args.mode.clone(),
        timeout: Duration::from_secs(args.timeout),
        corpus: to_absolute(args.corpus),
        crashes: to_absolute(args.crashes),
        seed: args.seed.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        }),
        entrypoint: to_absolute(args.entrypoint),
        schema_file: args.schema.map(to_absolute),
        ignored: args.ignore,
        simple_mutations: args.simple_mutations,
        replay: args.replay,
        methods_to_skip: args.skip_endpoints,
        port: args.port,
        use_validity: args.use_validity,
        replay_input: args.replay_input,
    };

    let shmem_provider = MmapShMemProvider::new()?;
    let cores = Cores::from_cmdline(args.cores.as_str())?;
    assert!(
        cores.ids.len() == 1,
        "make metrics and validity state non-global, fix monitor aggregate over clients, before running on multiple cores"
    );

    // let monitor = TuiMonitor::builder()
    //     .title("railcar")
    //     .version("0.1.0")
    //     .build();
    let monitor = create_monitor(|msg| {
        if msg.contains("Client Heartbeat") {
            log::info!("{msg}")
        } else {
            log::debug!("{msg}")
        }
    });

    if config.replay_input.is_some() {
        match config.mode {
            FuzzerMode::Bytes => {
                launch_replay_input::<BytesInput, _>(config, shmem_provider, monitor, cores)
            }
            FuzzerMode::Graph => {
                launch_replay_input::<Graph, _>(config, shmem_provider, monitor, cores)
            }
            FuzzerMode::Parametric => {
                launch_replay_input::<ParametricGraph, _>(config, shmem_provider, monitor, cores)
            }
        }
    } else if args.replay {
        match config.mode {
            FuzzerMode::Bytes => {
                launch_replay::<BytesInput, _>(config, shmem_provider, monitor, cores)
            }
            FuzzerMode::Graph => launch_replay::<Graph, _>(config, shmem_provider, monitor, cores),
            FuzzerMode::Parametric => {
                launch_replay::<ParametricGraph, _>(config, shmem_provider, monitor, cores)
            }
        }
    } else {
        match args.mode {
            FuzzerMode::Bytes => {
                launch_fuzzer(client::bytes::start, config, shmem_provider, monitor, cores)
            }
            FuzzerMode::Graph => {
                launch_fuzzer(client::graph::start, config, shmem_provider, monitor, cores)
            }
            FuzzerMode::Parametric => launch_fuzzer(
                client::parametric::start,
                config,
                shmem_provider,
                monitor,
                cores,
            ),
        }
    }
}
