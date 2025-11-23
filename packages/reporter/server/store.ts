/**
 * SPDX-FileCopyrightText: Mayant Mukul
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Global app state. Scrapes information for all available fuzzers under a given directory.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { $ } from "bun";
import { Database } from "bun:sqlite";

import { StatusCode } from "../api.ts";

export type Store = {
    rootDir: string;
    fuzzers: FuzzerInfo[];
};

export async function createStore(rootDir: string): Promise<Store> {
    const store: Store = { rootDir, fuzzers: [] };

    const glob = new Bun.Glob(`${rootDir}/**/fuzzer-config.json`);
    for await (const file of glob.scan()) {
        store.fuzzers.push(await createFuzzerInfoForDir(path.dirname(file)));
    }

    return store;
}

export async function updateStore(store: Store): Promise<void> {
    for (const fuzzer of store.fuzzers) {
        const [status, corpus, crashes, coverage] = await Promise.all([
            getFuzzerStatus(fuzzer.pid),
            getCorpusCount(fuzzer.paths.corpus),
            getCrashesCount(fuzzer.paths.crashes),
            getCoverage(fuzzer.db, fuzzer.startTime),
        ]);

        fuzzer.status = status;
        fuzzer.counters.corpus = corpus;
        fuzzer.counters.crashes = crashes;
        fuzzer.coverage = coverage;
    }
}

type FuzzerInfo = {
    status: StatusCode;
    pid: number;
    startTime: number;
    paths: {
        corpus: string;
        crashes: string;
    };
    counters: {
        corpus: number;
        crashes: number;
    };
    config: {
        mode: string;
        seed: number;
        labels: string[];
    };
    coverage: Point[];
    db: Database;
};

async function createFuzzerInfoForDir(dir: string): Promise<FuzzerInfo> {
    const {
        pid,
        start_time: startTime,
        config,
    } = await (Bun.file(
        `${dir}/fuzzer-config.json`,
    ).json() as Promise<FuzzerConfig>);

    const db = new Database(config.metrics);
    const [status, corpus, crashes, coverage] = await Promise.all([
        getFuzzerStatus(pid),
        getCorpusCount(config.corpus),
        getCrashesCount(config.crashes),
        getCoverage(db, startTime),
    ]);

    return {
        db,
        pid,
        status,
        coverage,
        startTime,
        paths: {
            corpus: config.corpus,
            crashes: config.crashes,
        },
        counters: { corpus, crashes },
        config: {
            mode: config.mode,
            seed: config.seed,
            labels: config.labels,
        },
    };
}

async function getFuzzerStatus(pid: number): Promise<StatusCode> {
    try {
        await $`ps ${pid}`.text();
        return StatusCode.Running;
    } catch {
        return StatusCode.Stopped;
    }
}

async function getCorpusCount(path: string): Promise<number> {
    if (!(await fs.exists(path))) {
        return 0;
    }
    const files = await fs.readdir(path);

    // every file `input` has a hidden `.input` file
    return files.length / 2;
}

async function getCrashesCount(path: string): Promise<number> {
    if (!(await fs.exists(path))) {
        return 0;
    }
    const files = await fs.readdir(path);

    // every file `input` has a hidden `.input` and `.input_1.metadata` file
    return files.length / 3;
}

async function getCoverage(db: Database, startTime: number): Promise<Point[]> {
    const query = db.query("SELECT timestamp, coverage FROM heartbeat;");
    const rows = query.all() as Pick<Heartbeat, "timestamp" | "coverage">[];

    // no data yet
    if (rows.length === 0) return [];

    const total = getTotalEdges(db);

    return rows.map((row) => [
        row.timestamp - startTime, // start from 0
        row.coverage / total, // save ratio
    ]);
}

function getTotalEdges(db: Database): number {
    const query = db.query(
        "SELECT total_edges FROM heartbeat ORDER BY timestamp DESC LIMIT 1",
    );
    const value = query.get() as Pick<Heartbeat, "total_edges">;
    return value.total_edges;
}

type Point = [number, number];

type FuzzerConfig = {
    config: {
        config_file: string;
        corpus: string;
        crashes: string;
        entrypoint: string;
        metrics: string;
        mode: string;
        port: number;
        replay: boolean;
        replay_input: string | null;
        schema_file: string | null;
        seed: number;
        simple_mutations: boolean;
        use_validity: boolean;
        labels: string[];
        timeout: {
            nanos: number;
            secs: number;
        };
        cores?: {
            cmdline: string;
            ids: number[];
        };
    };
    pid: number;
    start_time: number;
};

type Heartbeat = {
    timestamp: number;
    coverage: number;
    execs: number;
    valid_execs: number;
    valid_corpus: number;
    corpus: number;
    total_edges: number;
};
