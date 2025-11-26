#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Result;
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
    pub coverage: u64,
    pub execs: u64,
    pub valid_execs: u64,
    pub valid_corpus: u64,
    pub corpus: u64,
    pub total_edges: u64,
    pub labels: String,
}

impl Event for HeartbeatEvent {
    fn init(conn: &Connection) -> Result<()> {
        static CREATE_SQL: &str = "
        CREATE TABLE heartbeat (
            timestamp INTEGER NOT NULL,
            coverage UINT32 NOT NULL,
            execs UINT32 NOT NULL,
            valid_execs UINT32 NOT NULL,
            valid_corpus UINT32 NOT NULL,
            corpus UINT32 NOT NULL,
            total_edges UINT32 NOT NULL,
            labels TEXT
        )";

        static CHECK_SQL: &str = "
        SELECT name from sqlite_schema
        WHERE name = 'heartbeat'
        ";

        let mut check = conn.prepare(CHECK_SQL)?;
        let mut rows = check.query(())?;

        // create a new heartbeat table if none exists
        if rows.next()?.is_none() {
            _ = conn.execute(CREATE_SQL, ())?;
        }

        Ok(())
    }

    fn append(&self, conn: &Connection) -> Result<()> {
        static SQL: &str = "INSERT INTO heartbeat VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8);";

        let now: DateTime<Utc> = std::time::SystemTime::now().into();

        let changed = conn.execute(
            SQL,
            (
                now.timestamp(),
                self.coverage,
                self.execs,
                self.valid_execs,
                self.valid_corpus,
                self.corpus,
                self.total_edges,
                &self.labels,
            ),
        )?;
        debug_assert!(changed == 1);
        Ok(())
    }
}
