#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{
    fs::File,
    io::{BufWriter, Write},
};

use serde::Serialize;

static mut METRICS: Option<Metrics> = None;

struct Metrics {
    writer: BufWriter<File>,
}

pub fn init(path: &str, size: Option<usize>) {
    let file = std::fs::File::create(path).expect("failed to create metrics file");
    let writer = if let Some(size) = size {
        BufWriter::with_capacity(size, file)
    } else {
        BufWriter::new(file)
    };
    let instance = Metrics { writer };
    unsafe { METRICS = Some(instance) };
}

pub fn bump(name: &str) {
    fire(BumpEvent {
        name: name.to_owned(),
    });
}

pub fn flush() {
    if let Some(metrics) = unsafe { &mut METRICS } {
        metrics.writer.flush().expect("failed to flush events");
    } else {
        panic!("failed to flush metrics: uninitialized");
    }
}

fn flatten_event<E: Event>(event: &E) -> serde_json::Value {
    let mut payload = serde_json::to_value(event).unwrap();
    let Some(object) = payload.as_object_mut() else {
        panic!("event payload is not an object");
    };
    object.insert(
        "event_name".to_owned(),
        serde_json::Value::String(event.name().to_owned()),
    );
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        .floor();
    let timestamp: u64 = unsafe { timestamp.to_int_unchecked() };
    object.insert("timestamp".to_owned(), timestamp.into());
    payload
}

pub fn fire<E: Event>(event: E) {
    let payload = flatten_event(&event);
    let mut payload = serde_json::to_string(&payload).expect("failed to serialize event payload");
    payload.push('\n');
    if let Some(metrics) = unsafe { &mut METRICS } {
        metrics
            .writer
            .write_all(payload.as_bytes())
            .expect("failed to write event to logs");
        flush();
    } else {
        panic!("failed to fire metrics event: uninitialized");
    }
}

#[macro_export]
macro_rules! bump {
    ($x:expr) => {
        $crate::bump($x)
    };
}

pub trait Event: Serialize {
    fn name(&self) -> &str;
}

#[derive(Serialize)]
struct BumpEvent {
    name: String,
}

impl Event for BumpEvent {
    fn name(&self) -> &str {
        "bump"
    }
}
