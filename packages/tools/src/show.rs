/**
 * Generated with Amp
 * https://ampcode.com/threads/T-019f5e25-2cda-709d-aa10-02c42976afc2
 */
use std::{fs::File, io, path::PathBuf};

use anyhow::{Context, Result};
use clap::Parser;
use railcar::seq::ApiSeq;

/// Print a MessagePack file as JSON.
#[derive(Parser)]
struct Args {
    /// Path to the MessagePack file.
    path: PathBuf,
}

pub fn main() -> Result<()> {
    let args = Args::parse();
    let file = File::open(&args.path)
        .with_context(|| format!("failed to open MessagePack file {}", args.path.display()))?;
    let value: ApiSeq = rmp_serde::from_read(file)
        .with_context(|| format!("failed to decode MessagePack file {}", args.path.display()))?;

    serde_json::to_writer_pretty(io::stdout().lock(), &value)
        .context("failed to write JSON to stdout")?;
    println!();

    Ok(())
}
