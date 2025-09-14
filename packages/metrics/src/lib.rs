#![allow(static_mut_refs)]

// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Result;
use chrono::{DateTime, Utc};
use duckdb::{params, Connection};

use std::path::Path;

/// DuckDB-backed metrics database. Call `Metrics::init_for_event()` for every
/// event type you expect to receive.
pub struct Metrics {
    conn: Connection,
}

// Required by libafl::events::launcher::Launcher::launch()
impl Clone for Metrics {
    fn clone(&self) -> Self {
        Metrics::new(self.conn.path()).unwrap()
    }
}

impl Metrics {
    pub fn new<P: AsRef<Path>>(path: Option<P>) -> Result<Self> {
        let conn = if let Some(path) = path {
            Connection::open(path)?
        } else {
            Connection::open_in_memory()?
        };
        Ok(Self { conn })
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
}

impl Event for HeartbeatEvent {
    fn init(conn: &Connection) -> Result<()> {
        static CREATE_SQL: &str = "
        CREATE TABLE heartbeat (
            timestamp TIMESTAMP_S PRIMARY KEY,
            coverage UINT32 NOT NULL,
            execs UINT32 NOT NULL,
            valid_execs UINT32 NOT NULL,
            valid_corpus UINT32 NOT NULL,
            corpus UINT32 NOT NULL
        )";

        static CHECK_SQL: &str = "
        SELECT table_name from duckdb_tables
        WHERE table_name = 'heartbeat'
        ";

        let rows = conn.execute(CHECK_SQL, params![])?;
        assert!(rows <= 1);

        if rows == 0 {
            _ = conn.execute(CREATE_SQL, params![])?;
        }

        Ok(())
    }

    fn append(&self, conn: &Connection) -> Result<()> {
        static SQL: &str = "INSERT INTO heartbeat VALUES (?, ?, ?, ?, ?, ?);";

        let now: DateTime<Utc> = std::time::SystemTime::now().into();

        let changed = conn.execute(
            SQL,
            params![
                format!("{}", now.format("%+")),
                self.coverage,
                self.execs,
                self.valid_execs,
                self.valid_corpus,
                self.corpus
            ],
        )?;
        debug_assert!(changed == 1);
        Ok(())
    }
}

/// Bumps a counter tagged with a given name
pub struct BumpEvent {
    name: &'static str,
}

impl Event for BumpEvent {
    fn init(conn: &Connection) -> Result<()> {
        static CREATE_SQL: &str = "
        CREATE TABLE bump (
            timestamp TIMESTAMP_S UNIQUE NOT NULL,
            name STRING PRIMARY KEY,
            count UINT32 NOT NULL
        )";

        static CHECK_SQL: &str = "
        SELECT table_name from duckdb_tables
        WHERE table_name = 'bump'
        ";

        let rows = conn.execute(CHECK_SQL, params![])?;
        assert!(rows <= 1);

        if rows == 0 {
            _ = conn.execute(CREATE_SQL, params![])?;
        }

        Ok(())
    }

    fn append(&self, conn: &Connection) -> Result<()> {
        // create or increment a counter for `name`
        static SQL: &str = "
        INSERT INTO bump (timestamp, name, count)
        VALUES (?, ?, 1);
        ON CONFLICT(name) DO UPDATE SET count = count + 1
        ";

        let now: DateTime<Utc> = std::time::SystemTime::now().into();

        let changed = conn.execute(
            SQL,
            duckdb::params![format!("{}", now.format("%+")), self.name,],
        )?;
        debug_assert!(changed == 1);

        Ok(())
    }
}
