// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
    fs::File,
    io::{BufRead, BufWriter, Write},
    path::{Path, PathBuf},
    str::FromStr,
};

use anyhow::Result;
use glob::glob;
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;
use tools::{DiffSummary, SetDiff};

fn parse_metrics_filename(re: &Regex, path: &Path) -> Result<(usize, String)> {
    let Some(path) = path.to_str() else {
        anyhow::bail!("failed to convert path to string");
    };

    let Some(caps) = re.captures(path) else {
        anyhow::bail!("no regex matches for {}", path);
    };

    let mut iterator = caps.iter();
    _ = iterator.next(); // this will be the whole path

    let Some(iter) = iterator.next() else {
        anyhow::bail!("no match with iteration index");
    };
    let Some(iter) = iter else {
        anyhow::bail!("no match with iteration index");
    };
    let iter = iter.as_str().parse::<usize>()?;

    let Some(config) = iterator.next() else {
        anyhow::bail!("no match with benchmark config");
    };
    let Some(config) = config else {
        anyhow::bail!("no match with benchmark config");
    };
    let config = config.as_str().to_owned();

    Ok((iter, config))
}

fn append_fuzzer_coverage<W: Write>(writer: &mut W) -> Result<()> {
    let re = Regex::new(r"iter_(.)/(.*)/coverage/coverage.json")?;
    for entry in glob("**/coverage.json").expect("failed to read coverage json") {
        let entry = entry?;

        log::info!("- coverage {}", entry.to_str().unwrap());

        let (iteration, config) = parse_metrics_filename(&re, &entry)?;
        let json_str = std::fs::read_to_string(&entry)?;
        let Coverage { line, branch } = serde_json::from_str(&json_str)?;
        writeln!(writer, "{},{},{},{}", line, branch, config, iteration)?;
    }
    Ok(())
}

fn append_syntest_coverage<W: Write>(writer: &mut W) -> Result<()> {
    let exe = std::env::current_exe()?;
    let railcar_root = exe.parent().unwrap().parent().unwrap().parent().unwrap();
    let syntest_coverage_root = railcar_root.join("benchmarks/syntest-coverage");
    let pattern = format!(
        "{}/**/coverage.json",
        syntest_coverage_root.to_str().unwrap()
    );

    for entry in glob(&pattern).expect("failed to read syntest coverage json") {
        let entry = entry?;

        let project = entry.parent().unwrap().file_name().unwrap();
        let config = format!("{}_syntest", project.to_str().unwrap());

        let json_str = std::fs::read_to_string(&entry)?;
        let Coverage { line, branch } = serde_json::from_str(&json_str)?;
        writeln!(writer, "{},{},{},{}", line, branch, config, 0)?;
    }

    Ok(())
}

fn create_coverage() -> Result<PathBuf> {
    static NAME: &str = "coverage.csv";

    let mut writer = make_writer(NAME)?;
    writeln!(&mut writer, "line,branch,config,iteration")?;

    append_fuzzer_coverage(&mut writer)?;
    append_syntest_coverage(&mut writer)?;

    writer.flush()?;

    Ok(PathBuf::from_str(NAME)?)
}

fn diff_summ_csv_header(tag: &str) -> String {
    format!(
        "files_{},files_this,files_both,files_none,files_total,\
        lines_{},lines_this,lines_both,lines_none,lines_total,\
        branches_{},branches_this,branches_both,branches_none,branches_total",
        tag, tag, tag
    )
}

fn set_diff_to_csv(sd: &SetDiff) -> String {
    format!(
        "{},{},{},{},{}",
        sd.left, sd.right, sd.both, sd.none, sd.total
    )
}

fn diff_summ_to_csv(summ: &DiffSummary) -> String {
    let mut csv = String::new();

    csv.push_str(&set_diff_to_csv(&summ.files));
    csv.push(',');
    csv.push_str(&set_diff_to_csv(&summ.lines));
    csv.push(',');
    csv.push_str(&set_diff_to_csv(&summ.branches));

    csv
}

fn create_covdiff(tag: &str) -> Result<PathBuf> {
    let name = format!("covdiff_{}.csv", tag);
    let mut writer = make_writer(&name)?;

    writeln!(
        &mut writer,
        "{},config,iteration",
        diff_summ_csv_header(tag)
    )?;

    let re = Regex::new(r"iter_(.)/(.*)/covdiff")?;
    let pattern = format!("**/covdiff-{}.json", tag);
    for entry in glob(&pattern).expect("failed to find covdiff json") {
        let entry = entry?;

        let (iteration, config) = parse_metrics_filename(&re, &entry)?;
        let json_str = std::fs::read_to_string(&entry)?;
        let summ: DiffSummary = serde_json::from_str(&json_str)?;
        writeln!(
            &mut writer,
            "{},{},{}",
            diff_summ_to_csv(&summ),
            config,
            iteration
        )?;
    }

    writer.flush()?;

    Ok(PathBuf::from_str(&name)?)
}

pub fn main() -> Result<()> {
    env_logger::init();

    let mut args = std::env::args();

    _ = args.next(); // executable name
    let results_dir = args.next().expect("must provide path to results directory");

    std::env::set_current_dir(&results_dir)?;

    let coverage = create_coverage()?;

    let covdiff_syntest = create_covdiff("syntest")?;
    let covdiff_baseline = create_covdiff("baseline")?;

    let mut heartbeat = make_writer("heartbeat.csv")?;
    writeln!(
        &mut heartbeat,
        "event_name,coverage,execs,valid_execs,valid_corpus,corpus,timestamp,config,iteration"
    )?;

    let mut corpus = make_writer("corpus.csv")?;
    writeln!(
        &mut corpus,
        "event_name,valid,corpus,timestamp,config,iteration"
    )?;

    let mut bumps = make_writer("bumps.csv")?;
    writeln!(&mut bumps, "event_name,name,timestamp,config,iteration")?;

    let mut mutations = make_writer("mutations.csv")?;
    writeln!(
        &mut mutations,
        "event_name,input_id,mutation_name,output_id,timestamp,config,iteration"
    )?;

    let re = Regex::new(r"iter_(.)/(.*)/metrics.json")?;
    for entry in glob("**/metrics.json").expect("failed to read glob pattern") {
        let entry = entry?;

        let (iteration, config) = parse_metrics_filename(&re, &entry)?;
        let file = std::fs::File::open(&entry)?;
        let reader = std::io::BufReader::new(file);

        log::info!("- metrics {}", entry.to_str().unwrap());

        for line in reader.lines() {
            let Ok(line) = line else { continue };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let json: Value = serde_json::from_str(trimmed)?;
            let Value::Object(map) = &json else {
                anyhow::bail!("event data is not an object");
            };

            let event_name = map.get("event_name").unwrap().as_str().unwrap();
            if event_name == "corpus" {
                let event: CorpusAddEvent = serde_json::from_value(json).unwrap();
                writeln!(
                    &mut corpus,
                    "{},{},{},{},{},{}",
                    event.event_name, event.valid, event.corpus, event.timestamp, config, iteration,
                )?;
            } else if event_name == "heartbeat" {
                let event: HeartbeatEvent = serde_json::from_value(json).unwrap();
                writeln!(
                    &mut heartbeat,
                    "{},{},{},{},{},{},{},{},{}",
                    event.event_name,
                    event.coverage,
                    event.execs,
                    event.valid_execs,
                    event.valid_corpus.unwrap_or(0),
                    event.corpus.unwrap_or(0),
                    event.timestamp,
                    config,
                    iteration,
                )?;
            } else if event_name == "bump" {
                let event: BumpEvent = serde_json::from_value(json).unwrap();
                writeln!(
                    &mut bumps,
                    "{},{},{},{},{}",
                    event.event_name, event.name, event.timestamp, config, iteration
                )?;
            } else if event_name.contains("mutation") {
                let event: MutationEvent = serde_json::from_value(json).unwrap();
                writeln!(
                    &mut mutations,
                    "{},{},{},{},{},{},{}",
                    event.event_name,
                    event.input_id,
                    event.mutation_name,
                    event.output_id.unwrap_or("null".to_string()),
                    event.timestamp,
                    config,
                    iteration
                )?;
            }
        }
    }

    heartbeat.flush()?;
    bumps.flush()?;
    mutations.flush()?;
    corpus.flush()?;

    log::info!("writing sqlite...");
    let result = csvs_convert::csvs_to_sqlite(
        "metrics.db".to_owned(),
        vec![
            "heartbeat.csv".into(),
            "bumps.csv".into(),
            "mutations.csv".into(),
            "corpus.csv".into(),
            coverage.clone(),
            covdiff_syntest.clone(),
            covdiff_baseline.clone(),
        ],
    )?;
    log::debug!("{}", serde_json::to_string_pretty(&result)?);

    // Remove temporary csv files
    std::fs::remove_file("heartbeat.csv")?;
    std::fs::remove_file("corpus.csv")?;
    std::fs::remove_file("bumps.csv")?;
    std::fs::remove_file("mutations.csv")?;
    std::fs::remove_file(coverage)?;
    std::fs::remove_file(covdiff_syntest)?;
    std::fs::remove_file(covdiff_baseline)?;

    Ok(())
}

type Timestamp = u64;

#[derive(Deserialize)]
struct BumpEvent {
    event_name: String,
    name: String,
    timestamp: Timestamp,
}

#[derive(Deserialize)]
struct MutationEvent {
    event_name: String,
    input_id: String,
    mutation_name: String,
    output_id: Option<String>,
    timestamp: Timestamp,
}

#[derive(Deserialize)]
struct Coverage {
    line: f64,
    branch: f64,
}

#[derive(Deserialize)]
struct CorpusAddEvent {
    event_name: String,
    timestamp: Timestamp,
    valid: u64,
    corpus: u64,
}

#[derive(Deserialize)]
struct HeartbeatEvent {
    event_name: String,
    timestamp: Timestamp,
    coverage: u64,
    execs: u64,
    valid_execs: u64,
    valid_corpus: Option<u64>,
    corpus: Option<u64>,
}

fn make_writer(path: &str) -> Result<BufWriter<File>> {
    let file = File::create(path)?;
    Ok(BufWriter::new(file))
}
