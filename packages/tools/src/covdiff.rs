//! parse and do stuff with lcov
//! thanks to https://github.com/gifnksm/lcov/ for reference with the lcov format

#![allow(dead_code)]
#![allow(clippy::disallowed_types)]

use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
};

use anyhow::{bail, Result};
use tools::{DiffSummary, SetDiff, Trace};

const USAGE: &str = "usage: covdiff <file1> <file2>";

fn summarize(trace: &Trace) -> Result<()> {
    let hits: Option<(usize, usize)> = trace
        .files()
        .values()
        .map(|file| (file.num_branches_hit(), file.num_branches_found()))
        .reduce(|(acc_hits, acc_found), (hits, found)| (acc_hits + hits, acc_found + found));
    let Some((hits, found)) = hits else {
        bail!("no files in trace")
    };
    println!(
        "branch coverage {:04.2}%",
        100.0 * (hits as f64) / (found as f64)
    );

    let hits: Option<(usize, usize)> = trace
        .files()
        .values()
        .map(|file| (file.num_lines_hit(), file.num_lines_found()))
        .reduce(|(acc_hits, acc_found), (hits, found)| (acc_hits + hits, acc_found + found));
    let Some((hits, found)) = hits else {
        bail!("no files in trace")
    };
    println!(
        "line coverage {:04.2}%",
        100.0 * (hits as f64) / (found as f64)
    );

    Ok(())
}

#[derive(Default)]
struct FileDiff {
    name: String,
    lines: SetDiff,
    branches: SetDiff,
}

#[derive(Default)]
struct TraceDiff {
    per_file: HashMap<String, FileDiff>,
    files: SetDiff,
}

impl TraceDiff {
    fn new(left: &Trace, right: &Trace) -> Result<Self> {
        let mut td = TraceDiff::default();

        let all_files = all_keys(left.files(), right.files());
        td.files = SetDiff::new(&left.files_hit(), &right.files_hit(), &all_files);

        for file in &all_files {
            let left = left.files().get(file).unwrap();
            let right = right.files().get(file).unwrap();

            let all_lines = all_keys(left.lines(), right.lines());
            let all_branches = all_keys(left.branch_map(), right.branch_map());

            let fd = FileDiff {
                name: file.clone(),
                lines: SetDiff::new(&left.lines_hit(), &right.lines_hit(), &all_lines),
                branches: SetDiff::new(&left.branches_hit(), &right.branches_hit(), &all_branches),
            };
            td.per_file.insert(file.clone(), fd);
        }

        Ok(td)
    }

    fn summarize(&self) -> Result<()> {
        let lines = self
            .per_file
            .values()
            .map(|fd| fd.lines.clone())
            .reduce(SetDiff::merge)
            .unwrap();

        let branches = self
            .per_file
            .values()
            .map(|fd| fd.branches.clone())
            .reduce(SetDiff::merge)
            .unwrap();

        let files = self.files.clone();

        let summ = DiffSummary {
            files,
            lines,
            branches,
        };

        let ser_str = serde_json::to_string_pretty(&summ)?;
        println!("{}", ser_str);

        Ok(())
    }
}

fn all_keys<K, V1, V2>(a: &HashMap<K, V1>, b: &HashMap<K, V2>) -> HashSet<K>
where
    K: Hash + Eq + PartialEq + Clone,
{
    let a: HashSet<&K> = a.keys().collect();
    let b: HashSet<&K> = b.keys().collect();
    a.union(&b).cloned().cloned().collect()
}

pub fn main() -> Result<()> {
    let mut args = std::env::args();

    _ = args.next(); // executable name

    let first = args.next().expect(USAGE);
    let first = Trace::load_file(&first)?;

    let second = args.next().expect(USAGE);
    let second = Trace::load_file(&second)?;

    let diff = TraceDiff::new(&first, &second)?;
    diff.summarize()?;

    Ok(())
}
