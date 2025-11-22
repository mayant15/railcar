// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Result;
use std::{ops::Add, path::Path};

use libafl::monitors::{
    stats::{ClientStats, ClientStatsManager, UserStatsValue},
    Monitor, MultiMonitor,
};

use railcar_graph::metrics::{HeartbeatEvent, Metrics};

fn fold<F, T>(mgr: &ClientStatsManager, get: F) -> T
where
    F: Fn(&ClientStats) -> Option<T>,
    T: Default + Add<Output = T>,
{
    mgr.client_stats()
        .iter()
        .fold(T::default(), |acc, (_, x)| acc + get(x).unwrap_or_default())
}

fn coverage(stats: &ClientStats) -> Option<u64> {
    let stat = stats.get_user_stats("totalcoverage")?;
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

fn make_heartbeat_event(mgr: &ClientStatsManager) -> HeartbeatEvent {
    HeartbeatEvent {
        coverage: fold(mgr, coverage),
        valid_execs: fold(mgr, valid_execs),
        valid_corpus: fold(mgr, valid_corpus),
        total_edges: fold(mgr, total_edges),
        execs: fold(mgr, |s| Some(s.executions())),
        corpus: fold(mgr, |s| Some(s.corpus_size())),
    }
}

#[derive(Clone)]
pub struct StdMonitor<F: FnMut(&str)> {
    terminal: MultiMonitor<F>,
    metrics: Metrics,
}

impl<F: FnMut(&str)> StdMonitor<F> {
    pub fn new<P: AsRef<Path>>(print_fn: F, path: P) -> Result<Self> {
        let metrics = Metrics::new(Some(path))?;
        metrics.init_for_event::<HeartbeatEvent>()?;

        Ok(StdMonitor {
            terminal: MultiMonitor::new(print_fn),
            metrics,
        })
    }
}

impl<F: FnMut(&str)> Monitor for StdMonitor<F> {
    fn display(
        &mut self,
        mgr: &mut ClientStatsManager,
        event_msg: &str,
        sender_id: libafl_bolts::ClientId,
    ) -> Result<(), libafl::Error> {
        if event_msg == "Client Heartbeat" {
            let event = make_heartbeat_event(mgr);
            self.metrics
                .record(event)
                .map_err(|err| libafl::Error::unknown(err.to_string()))?;
        }
        self.terminal.display(mgr, event_msg, sender_id)?;
        Ok(())
    }
}
