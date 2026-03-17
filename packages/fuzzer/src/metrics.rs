#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Result;
use csv::{Writer, WriterBuilder};
use serde::Serialize;

use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub struct Metrics {
    path: PathBuf,
    writer: Option<Writer<File>>,
}

// Required by libafl::events::launcher::Launcher::launch()
// We're going to keep writer lazy.
impl Clone for Metrics {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            writer: None,
        }
    }
}

impl Metrics {
    pub fn new<P: AsRef<Path>>(path: P) -> Self {
        Self {
            path: path.as_ref().to_path_buf(),
            writer: None,
        }
    }

    pub fn record<E: Event>(&mut self, event: E) -> Result<()> {
        let writer = self.writer()?;
        writer.serialize(event)?;
        writer.flush()?;
        Ok(())
    }

    fn writer(&mut self) -> Result<&mut Writer<File>> {
        if self.writer.is_none() {
            let writer = WriterBuilder::new().from_path(&self.path)?;
            self.writer = Some(writer);
        }
        Ok(self.writer.as_mut().unwrap())
    }
}

pub trait Event: Serialize {}

#[derive(Serialize)]
pub struct HeartbeatEvent {
    pub timestamp: u64,
    pub objectives: u64,
    pub execs: u64,
    pub corpus: u64,
    pub coverage: u64,
    pub valid_execs: u64,
    pub valid_corpus: u64,
    pub valid_coverage: u64,
    pub total_edges: u64,
    pub labels: String,
}

impl Event for HeartbeatEvent {}
