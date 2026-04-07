// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Result;
use std::path::Path;

use libafl::monitors::{
    stats::{ClientStats, ClientStatsManager, UserStatsValue},
    Monitor, MultiMonitor,
};

use crate::metrics::{HeartbeatEvent, Metrics};

fn fold<F, T, R>(mgr: &ClientStatsManager, get: F, reducer: R) -> T
where
    F: Fn(&ClientStats) -> Option<T>,
    T: Default,
    R: Fn(T, T) -> T,
{
    mgr.client_stats().iter().fold(T::default(), |acc, (_, x)| {
        reducer(acc, get(x).unwrap_or_default())
    })
}

fn coverage(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("totalcoverage")?;
    let UserStatsValue::Ratio(covered, _) = stat.value() else {
        return None;
    };
    Some(*covered)
}

fn valid_coverage(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("validcoverage")?;
    let UserStatsValue::Ratio(covered, _) = stat.value() else {
        return None;
    };
    Some(*covered)
}

fn valid_execs(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("validexecs")?;
    let UserStatsValue::Number(valid_execs) = stat.value() else {
        return None;
    };
    Some(*valid_execs)
}

fn crashes(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("crashes")?;
    let UserStatsValue::Number(crashes) = stat.value() else {
        return None;
    };
    Some(*crashes)
}

fn valid_crashes(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("validcrashes")?;
    let UserStatsValue::Number(valid_crashes) = stat.value() else {
        return None;
    };
    Some(*valid_crashes)
}

fn total_edges(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("totaledges")?;
    let UserStatsValue::Number(total_edges) = stat.value() else {
        return None;
    };
    Some(*total_edges)
}

fn valid_corpus(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("validcorpus")?;
    let UserStatsValue::Number(valid_corpus) = stat.value() else {
        return None;
    };
    Some(*valid_corpus)
}

fn make_heartbeat_event(mgr: &mut ClientStatsManager, labels: String) -> HeartbeatEvent {
    use std::time::{SystemTime, UNIX_EPOCH};

    // global stats, aggregated over all clients
    let (execs, corpus, objectives) = {
        let gs = mgr.global_stats();
        (gs.total_execs, gs.corpus_size, gs.objective_size)
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("failed to find current system time");

    HeartbeatEvent {
        execs,
        corpus,
        objectives,
        labels,
        timestamp: now.as_secs(),

        // max
        coverage: fold(mgr, coverage, std::cmp::max),
        valid_coverage: fold(mgr, valid_coverage, std::cmp::max),

        // sum these
        valid_execs: fold(mgr, valid_execs, std::ops::Add::add),
        crashes: fold(mgr, crashes, std::ops::Add::add),
        valid_crashes: fold(mgr, valid_crashes, std::ops::Add::add),

        // max: these are global values, but freshly-spawned clients may report 0
        total_edges: fold(mgr, total_edges, std::cmp::max),
        valid_corpus: fold(mgr, valid_corpus, std::cmp::max),
    }
}

#[derive(Clone)]
pub struct StdMonitor<F: FnMut(&str)> {
    terminal: MultiMonitor<F>,
    metrics: Option<Metrics>,
    labels: String,
}

impl<F: FnMut(&str)> StdMonitor<F> {
    pub fn new<P: AsRef<Path>>(print_fn: F, path: Option<P>, labels: &[String]) -> Self {
        StdMonitor {
            metrics: path.map(Metrics::new),
            labels: labels.join(","),
            terminal: MultiMonitor::new(print_fn),
        }
    }
}

impl<F: FnMut(&str)> Monitor for StdMonitor<F> {
    fn display(
        &mut self,
        mgr: &mut ClientStatsManager,
        event_msg: &str,
        sender_id: libafl_bolts::ClientId,
    ) -> Result<(), libafl::Error> {
        self.terminal.display(mgr, event_msg, sender_id)?;
        if event_msg == "Client Heartbeat" {
            if let Some(metrics) = &mut self.metrics {
                let event = make_heartbeat_event(mgr, self.labels.clone());
                metrics
                    .record(event)
                    .map_err(|err| libafl::Error::unknown(err.to_string()))?;
            }
        }
        Ok(())
    }
}
