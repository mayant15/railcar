// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{collections::HashSet, path::PathBuf};

use anyhow::Result;
use clap::Parser;
use tools::Trace;

/// Report branch and line coverage
#[derive(Parser)]
struct Args {
    lcov: PathBuf,

    #[arg(short, long)]
    files: Vec<PathBuf>,
}

pub fn main() -> Result<()> {
    let args = Args::parse();
    let trace = Trace::load_file(args.lcov)?;

    let includes = args.files.into_iter().collect::<HashSet<PathBuf>>();

    let filter = if includes.is_empty() {
        None
    } else {
        Some(&includes)
    };

    println!("line {}%", trace.line_coverage(filter));
    println!("branch {}%", trace.branch_coverage(filter));

    Ok(())
}
