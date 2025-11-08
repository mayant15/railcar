// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{path::PathBuf, str::FromStr, time::Duration};

use anyhow::Result;
use clap::Parser;
use libafl::{
    events::{EventConfig, Launcher},
    inputs::BytesInput,
    monitors::Monitor,
};
use libafl_bolts::{
    core_affinity::Cores,
    shmem::{MmapShMemProvider, ShMemProvider},
};
use railcar_graph::{Graph, ParametricGraph};

use railcar::client::{FuzzerConfig, FuzzerMode, RestartingManager, State, ToFuzzerInput};
use railcar::monitor::create_monitor;

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

    /// Directory to save corpus, crashes and temporary files
    #[arg(long)]
    outdir: Option<String>,

    /// Fuzz driver variant to use
    #[arg(long, value_enum, default_value_t = FuzzerMode::Graph)]
    mode: FuzzerMode,

    /// Port to spawn the IPC broker on. If spawning multiple instances they should have different
    /// ports.
    #[arg(long, default_value_t = 1337)]
    port: u16,

    /// Seed for the random number generator for deterministic execution
    #[arg(long)]
    seed: Option<u64>,

    // TODO: make cores optional
    /// Cores to run on. Comma-separated numbers and ranges, like "1,2-4,6" or "all"
    #[arg(long, default_value_t = String::from_str("1").unwrap())]
    cores: String,

    /// Path to a schema file for the target library. Will be inferred at run-time otherwise
    #[arg(long)]
    schema: Option<String>,

    /// Use simple mutations when using the graph driver
    #[arg(long, default_value_t = false)]
    simple_mutations: bool,

    /// Use validity feedback. Enabled by default for graph and parametric drivers. Disabled by
    /// default for bytes driver.
    #[arg(long)]
    use_validity: Option<bool>,

    /// Configuration file to pick options from
    #[arg(long, default_value_t = String::from_str("railcar.config.js").unwrap())]
    config: String,
}

fn to_absolute(path: String) -> PathBuf {
    let path = PathBuf::from_str(path.as_str()).unwrap();
    let path = if path.is_absolute() {
        path
    } else {
        let cwd = std::env::current_dir().unwrap();
        cwd.join(path)
    };
    path.canonicalize().unwrap()
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
        railcar::client::replay_input::<I, _>(restarting_mgr, &config)
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
        railcar::client::replay::<I, _>(state, restarting_mgr, &config)
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
        .filter(None, log::LevelFilter::Info)
        .filter(
            Some("railcar"),
            if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            },
        )
        .init();

    let args = Arguments::parse();

    let cores = Cores::from_cmdline(args.cores.as_str())?;
    assert!(
        cores.ids.len() == 1,
        "make metrics and validity state non-global, fix monitor aggregate over clients, before running on multiple cores"
    );

    let outdir = args
        .outdir
        .map(to_absolute)
        .unwrap_or_else(|| std::env::current_dir().unwrap().join("railcar-out"));

    std::fs::create_dir_all(&outdir)?;

    let config = railcar::client::FuzzerConfig {
        mode: args.mode.clone(),
        timeout: Duration::from_secs(args.timeout),
        corpus: outdir.join("corpus"),
        crashes: outdir.join("crashes"),
        metrics: outdir.join("metrics.db"),
        seed: args.seed.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        }),
        entrypoint: to_absolute(args.entrypoint),
        schema_file: args.schema.map(to_absolute),
        simple_mutations: args.simple_mutations,
        replay: args.replay,
        port: args.port,
        use_validity: args.use_validity.unwrap_or(args.mode != FuzzerMode::Bytes),
        replay_input: args.replay_input,
        config_file: to_absolute(args.config),
        cores: cores.clone(),
    };

    let shmem_provider = MmapShMemProvider::new()?;

    dump_run_metadata(outdir, &config)?;

    // let monitor = TuiMonitor::builder()
    //     .title("railcar")
    //     .version("0.1.0")
    //     .build();
    let monitor = create_monitor(&config.metrics, |msg| {
        if msg.contains("Client Heartbeat") {
            log::info!("{msg}")
        } else {
            log::debug!("{msg}")
        }
    })?;

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
            FuzzerMode::Bytes => launch_fuzzer(
                railcar::client::bytes::start,
                config,
                shmem_provider,
                monitor,
                cores,
            ),
            FuzzerMode::Graph => launch_fuzzer(
                railcar::client::graph::start,
                config,
                shmem_provider,
                monitor,
                cores,
            ),
            FuzzerMode::Parametric => launch_fuzzer(
                railcar::client::parametric::start,
                config,
                shmem_provider,
                monitor,
                cores,
            ),
        }
    }
}

/// Write some metadata about this fuzzer run to a file. We can use this
/// to monitor experiments.
fn dump_run_metadata(outdir: PathBuf, config: &FuzzerConfig) -> Result<()> {
    let metadata = serde_json::json!({
        "start_time": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        "pid": std::process::id(),
        "config": config,
    });
    let metadata_string = serde_json::to_string_pretty(&metadata)?;
    std::fs::write(outdir.join("fuzzing-config.json"), metadata_string)?;
    Ok(())
}
