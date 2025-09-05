#![allow(dead_code)]

use metrics::Event;
use serde::Serialize;

#[inline]
pub fn fire_heartbeat_event(
    coverage: u64,
    execs: u64,
    valid_execs: u64,
    valid_corpus: u64,
    corpus: u64,
) {
    metrics::fire(HeartbeatEvent {
        coverage,
        execs,
        valid_execs,
        valid_corpus,
        corpus,
    });
}

#[inline]
pub fn fire_mutation_skip_event(name: String, input: String) {
    let event = MutationEvent::new("mutation_skip", name, input, None);
    metrics::fire(event);
}

#[inline]
pub fn fire_mutation_undo_event(name: String, input: String) {
    let event = MutationEvent::new("mutation_undo", name, input, None);
    metrics::fire(event);
}

#[inline]
pub fn fire_mutation_error_event(name: String, input: String) {
    let event = MutationEvent::new("mutation_error", name, input, None);
    metrics::fire(event);
}

#[inline]
#[allow(dead_code)]
pub fn fire_mutation_success_event(name: String, input: String, output: String) {
    let event = MutationEvent::new("mutation_success", name, input, Some(output));
    metrics::fire(event);
}

#[inline]
pub fn fire_mutation_noop_event(name: String, input: String) {
    let event = MutationEvent::new("mutation_noop", name, input, None);
    metrics::fire(event);
}

#[derive(Serialize)]
struct MutationEvent {
    #[serde(skip)]
    event: String,
    mutation_name: String,
    input_id: String,
    output_id: Option<String>,
}

impl MutationEvent {
    fn new(
        event: &str,
        mutation_name: String,
        input_id: String,
        output_id: Option<String>,
    ) -> Self {
        MutationEvent {
            event: event.to_owned(),
            mutation_name,
            input_id,
            output_id,
        }
    }
}

impl Event for MutationEvent {
    fn name(&self) -> &str {
        self.event.as_str()
    }
}

#[derive(Serialize)]
struct HeartbeatEvent {
    coverage: u64,
    execs: u64,
    valid_execs: u64,
    valid_corpus: u64,
    corpus: u64,
}

impl Event for HeartbeatEvent {
    fn name(&self) -> &str {
        "heartbeat"
    }
}

#[derive(Serialize)]
struct CorpusAddEvent {
    valid: u64,
    corpus: u64,
}

impl Event for CorpusAddEvent {
    fn name(&self) -> &str {
        "corpus"
    }
}
