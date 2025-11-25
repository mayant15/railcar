// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{path::PathBuf, str::FromStr, time::Duration};

use anyhow::Result;
use clap::Parser;
use libafl_bolts::{
    core_affinity::Cores,
    shmem::{MmapShMemProvider, ShMemProvider},
};
use railcar::{monitor::StdMonitor, FuzzerConfig, FuzzerMode};

mod client;
mod ensemble;
mod replay;
mod replay_input;

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

    /// Run the fuzzer in ensemble mode. This runs two sub-fuzzers: one to search for API
    /// sequences and one for constants.
    #[arg(long, default_value_t = false)]
    ensemble: bool,

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
    #[arg(long)]
    config: Option<PathBuf>,

    /// Label this fuzzer to find it in the reporter UI.
    #[arg(long)]
    label: Option<String>, // TODO: ^ making this a vector crashes in release builds (some serde issue)
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

fn find_config_file(path: Option<PathBuf>) -> Result<Option<PathBuf>> {
    if let Some(path) = &path {
        std::fs::File::open(path)?;
        return Ok(Some(path.clone()));
    }

    // no config provided, try to find one in the current directory
    let cwd = std::env::current_dir()?;
    let default_config = cwd.join("railcar.config.js");
    if std::fs::exists(&default_config)? {
        Ok(Some(default_config))
    } else {
        Ok(None)
    }
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

    let outdir = args
        .outdir
        .map(to_absolute)
        .unwrap_or_else(|| std::env::current_dir().unwrap().join("railcar-out"));

    std::fs::create_dir_all(&outdir)?;

    let config = FuzzerConfig {
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
        config_file: find_config_file(args.config)?,
        cores: cores.clone(),
        labels: if let Some(label) = args.label {
            vec![label]
        } else {
            Vec::new()
        },
    };

    let shmem_provider = MmapShMemProvider::new()?;

    // let monitor = TuiMonitor::builder()
    //     .title("railcar")
    //     .version("0.1.0")
    //     .build();
    let monitor = StdMonitor::new(
        |msg| {
            if msg.contains("Client Heartbeat") {
                log::info!("{msg}")
            } else {
                log::debug!("{msg}")
            }
        },
        &config.metrics,
    )?;

    dump_run_metadata(outdir, &config)?;
    log_start(&config);

    if config.replay_input.is_some() {
        return replay_input::launch(config, shmem_provider, monitor, cores);
    }

    if args.replay {
        return replay::launch(config, shmem_provider, monitor, cores);
    }

    if args.ensemble {
        return ensemble::launch(config, shmem_provider, monitor, cores);
    }

    client::launch(config, shmem_provider, monitor, cores)
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
    std::fs::write(outdir.join("fuzzer-config.json"), metadata_string)?;
    Ok(())
}

fn log_start(config: &FuzzerConfig) {
    if let Some(input) = &config.replay_input {
        log::info!("[*] starting replay for input");
        log::info!("       input: {}", input);
    } else if config.replay {
        log::info!("[*] starting replay");
    } else {
        log::info!("[*] starting fuzzer");
    }

    log::info!("      target: {:?}", config.entrypoint);
    log::info!("      driver: {:?}", config.mode);
    log::info!("      schema: {:?}", config.schema_file);
    log::info!("      simple: {}", config.simple_mutations);
    log::info!("        seed: {}", config.seed);
}
