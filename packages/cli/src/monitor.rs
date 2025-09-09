// SPDX-License-Identifier: AGPL-3.0-or-later

use std::time::Duration;

use libafl::monitors::{ClientStats, CombinedMonitor, Monitor, MultiMonitor, UserStatsValue};
use libafl_bolts::current_time;

use crate::events::fire_heartbeat_event;

#[derive(Clone)]
pub struct HeartbeatMonitor {
    client_stats: Vec<ClientStats>,
    start_time: Duration,
}

impl HeartbeatMonitor {
    fn new() -> Self {
        Self {
            start_time: current_time(),
            client_stats: Vec::new(),
        }
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
}

impl Monitor for HeartbeatMonitor {
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
            fire_heartbeat_event(
                coverage,
                self.total_execs(),
                self.valid_execs(),
                self.valid_corpus(),
                self.corpus_size(),
            );
        }
    }
}

pub type StdMonitor<F> = CombinedMonitor<MultiMonitor<F>, HeartbeatMonitor>;

pub fn create_monitor<F>(print_fn: F) -> StdMonitor<F>
where
    F: FnMut(&str),
{
    StdMonitor::new(MultiMonitor::new(print_fn), HeartbeatMonitor::new())
}
