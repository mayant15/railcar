use std::{path::PathBuf, time::Duration};

use anyhow::Result;
use clap::Parser;
use libafl::monitors::Monitor;
use libafl_bolts::{
    core_affinity::Cores,
    shmem::{ShMemProvider, StdShMemProvider},
};
use railcar::{monitor::StdMonitor, FuzzerConfig, FuzzerMode};

mod replay_corpus;
mod replay_input;

/// Fuzzer for JavaScript libraries with automatic fuzz drivers
#[derive(Parser)]
#[command(version)]
struct Arguments {
    /// Entrypoint for the library to test for automatic drivers.
    /// File that exports a `fuzz` function for bytes driver.
    entrypoint: PathBuf,

    /// Replay the corpus from an existing output directory. Use this with `nyc` to report coverage.
    #[arg(long, default_value_t = false)]
    replay: bool,

    /// Replay a single input.
    #[arg(long)]
    replay_input: Option<PathBuf>,

    /// Per-testcase timeout in seconds.
    #[arg(long, default_value_t = 10)]
    timeout: u64,

    /// Directory to save corpus, crashes and temporary files.
    #[arg(long)]
    outdir: Option<PathBuf>,

    /// Path to a metrics database file. Railcar will create one if it doesn't exist.
    #[arg(long)]
    metrics: Option<PathBuf>,

    /// Fuzz driver variant to use.
    #[arg(long, value_enum, default_value_t = FuzzerMode::Sequence)]
    mode: FuzzerMode,

    /// Port to spawn the IPC broker on. If spawning multiple instances they should have different
    /// ports.
    #[arg(long, default_value_t = 1337)]
    port: u16,

    /// Seed for the random number generator for deterministic execution.
    #[arg(long)]
    seed: Option<u64>,

    /// Cores to run on. Comma-separated numbers and ranges, like "1,2-4,6" or "all".
    #[arg(long)]
    cores: Option<String>,

    /// Path to a schema file for the target library. Will be inferred at run-time otherwise.
    #[arg(long)]
    schema: Option<PathBuf>,

    /// Configuration file to pick options from.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Attach labels to this fuzzer for future identification.
    #[arg(long)]
    label: Vec<String>,

    /// Stop the fuzzer after a fixed number of inputs.
    #[arg(long)]
    iterations: Option<u64>,

    /// DEBUG: Dump the fuzzer's in-memory schema to a file.
    #[arg(long)]
    debug_dump_schema: Option<PathBuf>,
}

fn to_absolute(path: PathBuf) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path
    } else {
        let cwd = std::env::current_dir()?;
        cwd.join(path)
    };
    let path = path.canonicalize()?;
    Ok(path)
}

fn find_config_file(path: Option<PathBuf>) -> Result<Option<PathBuf>> {
    if let Some(path) = path {
        let path = to_absolute(path)?;
        std::fs::File::open(&path)?;
        return Ok(Some(path));
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

fn init_logger() {
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
}

fn resolve_cores(cores: Option<String>) -> Result<Cores> {
    let cores = if let Some(cores) = cores {
        Cores::from_cmdline(cores.as_str())?
    } else {
        // NOTE: Can maybe change this to pick an appropriate core from the available ones
        // For now though, just pick in whatever order libafl puts them in
        let mut cores = Cores::all()?;
        cores.trim(1)?;
        cores
    };

    Ok(cores)
}

fn resolve_outdir(outdir: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(outdir) = outdir {
        return to_absolute(outdir);
    }

    let cwd = std::env::current_dir()?;
    Ok(cwd.join("railcar-out"))
}

fn resolve_seed(seed: Option<u64>) -> Result<u64> {
    if let Some(seed) = seed {
        return Ok(seed);
    }

    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();

    Ok(seed)
}

fn main() -> Result<()> {
    init_logger();

    let args = Arguments::parse();

    let cores = resolve_cores(args.cores)?;

    let outdir = resolve_outdir(args.outdir)?;
    if args.replay {
        assert!(
            std::fs::exists(&outdir)?,
            "--replay requires an existing output directory"
        );
    }
    std::fs::create_dir_all(&outdir)?;

    let seed = resolve_seed(args.seed)?;

    let config_file = find_config_file(args.config)?;

    let config = FuzzerConfig {
        seed,
        config_file,
        mode: args.mode.clone(),
        timeout: Duration::from_secs(args.timeout),
        corpus: outdir.join("corpus"),
        crashes: outdir.join("crashes"),
        metrics: args.metrics.unwrap_or_else(|| outdir.join("metrics.db")),
        entrypoint: to_absolute(args.entrypoint)?,
        schema_file: args.schema.map(|s| to_absolute(s).unwrap()),
        replay: args.replay,
        port: args.port,
        replay_input: args.replay_input,
        cores: cores.clone(),
        labels: args.label,
        iterations: args.iterations,
        debug_dump_schema: args.debug_dump_schema,
    };

    let shmem_provider = StdShMemProvider::new()?;

    let monitor = StdMonitor::new(
        |msg| {
            if msg.contains("Client Heartbeat") {
                log::info!("{msg}")
            } else {
                log::debug!("{msg}")
            }
        },
        if config.is_replay() {
            None
        } else {
            Some(&config.metrics)
        },
        &config.labels,
    )?;

    if !config.is_replay() {
        dump_run_metadata(outdir, &config)?;
    }
    log_start(&config);

    if config.replay_input.is_some() {
        return replay_input::launch(config, shmem_provider, monitor, cores);
    }

    if args.replay {
        return replay_corpus::launch(config, shmem_provider, monitor, cores);
    }

    launch(config, shmem_provider, monitor, cores)
}

fn launch<M>(
    config: FuzzerConfig,
    shmem_provider: StdShMemProvider,
    monitor: M,
    cores: Cores,
) -> Result<()>
where
    M: Monitor + Clone,
{
    match config.mode {
        FuzzerMode::Bytes => railcar::bytes::launch(config, shmem_provider, monitor, cores),
        FuzzerMode::Sequence => railcar::launch_seq_fuzzer(config, shmem_provider, monitor, cores),
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
    std::fs::write(outdir.join("fuzzer-config.json"), metadata_string)?;
    Ok(())
}

fn log_start(config: &FuzzerConfig) {
    if let Some(input) = &config.replay_input {
        log::info!("[*] starting replay for input");
        log::info!("       input: {}", input.to_str().unwrap());
    } else if config.replay {
        log::info!("[*] starting replay");
    } else {
        log::info!("[*] starting fuzzer");
    }

    log::info!("      target: {:?}", config.entrypoint);
    log::info!("      driver: {:?}", config.mode);
    log::info!("      schema: {:?}", config.schema_file);
    log::info!("        seed: {}", config.seed);
}
