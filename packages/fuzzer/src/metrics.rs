#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use rusqlite::Connection;

use std::{path::Path, rc::Rc};

/// DuckDB-backed metrics database. Call `Metrics::init_for_event()` for every
/// event type you expect to receive.
#[derive(Clone)] // Required by libafl::events::launcher::Launcher::launch()
pub struct Metrics {
    conn: Rc<Connection>,
}

impl Metrics {
    pub fn new<P: AsRef<Path>>(path: Option<P>) -> Result<Self> {
        let conn = if let Some(path) = path {
            let exists = std::fs::exists(&path)?;
            let conn = Connection::open(path)?;
            if !exists {
                conn.pragma_update(None, "journal_mode", "WAL")?;
            }
            Ok(conn)
        } else {
            Connection::open_in_memory()
        }?;
        Ok(Self {
            conn: Rc::new(conn),
        })
    }

    pub fn init_for_event<E: Event>(&self) -> Result<()> {
        E::init(&self.conn)
    }

    pub fn record<E: Event>(&self, event: E) -> Result<()> {
        event.append(&self.conn)
    }
}

pub trait Event {
    fn init(conn: &Connection) -> Result<()>;
    fn append(&self, conn: &Connection) -> Result<()>;
}

pub struct HeartbeatEvent {
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

impl Event for HeartbeatEvent {
    fn init(conn: &Connection) -> Result<()> {
        static CREATE_SQL: &str = "
        CREATE TABLE heartbeat (
            timestamp INTEGER NOT NULL,
            objectives UINT32 NOT NULL,
            execs UINT32 NOT NULL,
            corpus UINT32 NOT NULL,
            coverage UINT32 NOT NULL,
            valid_execs UINT32 NOT NULL,
            valid_corpus UINT32 NOT NULL,
            valid_coverage UINT32 NOT NULL,
            total_edges UINT32 NOT NULL,
            labels TEXT
        )";

        // if we're sharing a database between multiple fuzzers, the table might already exist
        if let Err(e) = conn.execute(CREATE_SQL, ()) {
            let rusqlite::Error::SqliteFailure(_, Some(msg)) = &e else {
                bail!("{}", e)
            };
            if msg != "table heartbeat already exists" {
                bail!("{}", e);
            }
        }

        Ok(())
    }

    fn append(&self, conn: &Connection) -> Result<()> {
        static SQL: &str =
            "INSERT INTO heartbeat VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10);";

        let now: DateTime<Utc> = std::time::SystemTime::now().into();

        let changed = conn.execute(
            SQL,
            (
                now.timestamp(),
                self.objectives,
                self.execs,
                self.corpus,
                self.coverage,
                self.valid_execs,
                self.valid_corpus,
                self.valid_coverage,
                self.total_edges,
                &self.labels,
            ),
        )?;
        debug_assert!(changed == 1);
        Ok(())
    }
}
