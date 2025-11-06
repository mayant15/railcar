// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Result;
use std::{path::Path, time::Duration};

use libafl::monitors::{ClientStats, CombinedMonitor, Monitor, MultiMonitor, UserStatsValue};
use libafl_bolts::current_time;

use metrics::{HeartbeatEvent, Metrics};

#[derive(Clone)] // Required by libafl::events::launcher::Launcher::launch()
pub struct MetricsMonitor {
    client_stats: Vec<ClientStats>,
    start_time: Duration,
    metrics: Metrics,
}

impl MetricsMonitor {
    fn new<P: AsRef<Path>>(path: Option<P>) -> Result<Self> {
        let metrics = Metrics::new(path)?;
        metrics.init_for_event::<HeartbeatEvent>()?;

        Ok(Self {
            start_time: current_time(),
            client_stats: Vec::new(),
            metrics,
        })
    }

    fn coverage(&self) -> u64 {
        static COVERAGE_STAT: &str = "totalcoverage";

        self.client_stats().iter().fold(0, |acc, x| {
            let Some(stat) = x.get_user_stats(COVERAGE_STAT) else {
                return acc;
            };
            let UserStatsValue::Ratio(covered, _) = stat.value() else {
                return acc;
            };
            // TODO: How do we want to aggregate this over multiple clients? Average?
            acc + covered
        })
    }

    fn valid_execs(&self) -> u64 {
        static VALID_EXECS_STAT: &str = "validexecs";

        self.client_stats().iter().fold(0, |acc, x| {
            let Some(stat) = x.get_user_stats(VALID_EXECS_STAT) else {
                return acc;
            };
            let UserStatsValue::Number(valid_execs) = stat.value() else {
                return acc;
            };
            acc + valid_execs
        })
    }

    fn valid_corpus(&self) -> u64 {
        static VALID_CORPUS_STAT: &str = "validcorpus";

        self.client_stats().iter().fold(0, |acc, x| {
            let Some(stat) = x.get_user_stats(VALID_CORPUS_STAT) else {
                return acc;
            };
            let UserStatsValue::Number(valid_execs) = stat.value() else {
                return acc;
            };
            acc + valid_execs
        })
    }

    fn total_instrumented_edges(&self) -> u64 {
        self.client_stats().iter().fold(0, |acc, x| {
            let Some(stat) = x.get_user_stats("totaledges") else {
                return acc;
            };
            let UserStatsValue::Number(total_edges) = stat.value() else {
                return acc;
            };
            acc + total_edges
        })
    }
}

impl Monitor for MetricsMonitor {
    fn client_stats_mut(&mut self) -> &mut Vec<ClientStats> {
        &mut self.client_stats
    }

    fn client_stats(&self) -> &[ClientStats] {
        &self.client_stats
    }

    fn start_time(&self) -> Duration {
        self.start_time
    }

    fn set_start_time(&mut self, time: Duration) {
        self.start_time = time;
    }

    fn display(&mut self, event_msg: &str, _sender_id: libafl_bolts::ClientId) {
        if event_msg == "Client Heartbeat" {
            let coverage = self.coverage();
            if let Err(err) = self.metrics.record(HeartbeatEvent {
                coverage,
                execs: self.total_execs(),
                valid_execs: self.valid_execs(),
                valid_corpus: self.valid_corpus(),
                corpus: self.corpus_size(),
                total_edges: self.total_instrumented_edges(),
            }) {
                panic!("{}", err);
            };
        }
    }
}

pub type StdMonitor<F> = CombinedMonitor<MultiMonitor<F>, MetricsMonitor>;

pub fn create_monitor<F, P: AsRef<Path>>(path: P, print_fn: F) -> Result<StdMonitor<F>>
where
    F: FnMut(&str),
{
    Ok(StdMonitor::new(
        MultiMonitor::new(print_fn),
        MetricsMonitor::new(Some(path))?,
    ))
}
