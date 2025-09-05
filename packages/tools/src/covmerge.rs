use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use tools::Trace;

/// Merge lcov coverage reports into one (union)
#[derive(Parser)]
struct Args {
    paths: Vec<PathBuf>,

    #[arg(short, long)]
    out: Option<PathBuf>,
}

pub fn main() -> Result<()> {
    let args = Args::parse();

    let merged = args
        .paths
        .into_iter()
        .map(|path| match Trace::load_file(&path) {
            Ok(trace) => trace,
            Err(e) => panic!(
                "failed to load lcov file at {}: {}",
                path.to_str().unwrap(),
                e
            ),
        })
        .reduce(|mut acc, next| {
            acc.merge(&next);
            acc
        })
        .expect("no coverage files to merge");

    let lcov = merged.to_lcov_string()?;

    if let Some(out) = args.out {
        std::fs::write(out, lcov)?;
    } else {
        println!("{}", lcov);
    }

    Ok(())
}
