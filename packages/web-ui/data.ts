import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";

import {$} from "bun"
import { Database } from "bun:sqlite";

export enum FuzzerStatusCode {
    Running,
    Crashed,
    Exited,
}

type TimePoint<T> = {
    timestamp: number;
    data: T;
};

type FuzzerStatus = {
    db?: Database;
    code: FuzzerStatusCode;
    corpusCount: number;
    crashesCount: number;
    coverage: TimePoint<number>[];
};

export type ProjectInfo = {
    // constants that are not going to change over time
    name: string;
    outdir: string;
    corpusPath: string;
    crashesPath: string;
    metricsPath: string;
    mode: string;
    port: number;
    schemaPath: string | null;
    seed: number;
    perTestTimeout: number;
    pid: number;
    startTime: number;
    metrics?: Database;

    // status that would change over time
    status?: FuzzerStatus;
};

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

async function fetchFuzzerCorpusCount(info: ProjectInfo): Promise<number> {
    if (!(await fs.exists(info.corpusPath))) {
        return 0;
    }
    const files = await fs.readdir(info.corpusPath);

    // every file `input` has a hidden `.input` file
    return files.length / 2;
}

async function fetchFuzzerCrashesCount(info: ProjectInfo): Promise<number> {
    if (!(await fs.exists(info.crashesPath))) {
        return 0;
    }
    const files = await fs.readdir(info.crashesPath);

    // every file `input` has a hidden `.input` and `.input_1.metadata` file
    return files.length / 3;
}

type Heartbeat = {
    timestamp: number;
    coverage: number;
    execs: number;
    valid_execs: number;
    valid_corpus: number;
    corpus: number;
    total_edges: number;
};

function getTotalEdges(metrics: Database): number {
    const query = metrics.query(
        "SELECT total_edges FROM heartbeat ORDER BY timestamp DESC LIMIT 1",
    );
    const value = query.get() as { total_edges: number };
    return value.total_edges;
}

async function fetchCoverage(info: ProjectInfo): Promise<TimePoint<number>[]> {
    if (info.metrics === undefined) {
        info.metrics = await tryConnectToDb(info.metricsPath);
    }

    assert(info.metrics !== undefined);

    const query = info.metrics.query(
        "SELECT timestamp, coverage FROM heartbeat;",
    );
    const rows = query.all() as Pick<Heartbeat, "timestamp" | "coverage">[];

    // no data yet
    if (rows.length === 0) return [];

    // TODO: can probably do this on init and save it
    const total = getTotalEdges(info.metrics);

    return rows.map((row) => ({
        timestamp: row.timestamp - info.startTime,
        data: row.coverage / total,
    }));
}

async function fetchFuzzerStatusCode(info: ProjectInfo): Promise<FuzzerStatusCode> {
    try {
        await $`ps ${info.pid}`.text()
        return FuzzerStatusCode.Running;
    } catch (err) {
        return FuzzerStatusCode.Crashed;
    }
}

async function fetchFuzzerStatus(info: ProjectInfo): Promise<ProjectInfo> {
    const [code, corpusCount, crashesCount, coverage] = await Promise.all([
        fetchFuzzerStatusCode(info),
        fetchFuzzerCorpusCount(info),
        fetchFuzzerCrashesCount(info),
        fetchCoverage(info),
    ]);

    return {
        ...info,
        status: {
            code,
            corpusCount,
            crashesCount,
            coverage,
        },
    };
}

export async function collectProjectInfoForDir(
    dir: string,
): Promise<ProjectInfo> {
    const name = await Bun.file(`${dir}/project`).text();
    const fuzzerConfig: FuzzerConfig = await Bun.file(
        `${dir}/fuzzing-config.json`,
    ).json();

    return fetchFuzzerStatus({
        name,
        outdir: dir,
        metricsPath: fuzzerConfig.config.metrics,
        corpusPath: fuzzerConfig.config.corpus,
        crashesPath: fuzzerConfig.config.crashes,
        mode: fuzzerConfig.config.mode,
        port: fuzzerConfig.config.port,
        schemaPath: fuzzerConfig.config.schema_file,
        seed: fuzzerConfig.config.seed,
        perTestTimeout:
            fuzzerConfig.config.timeout.secs +
            fuzzerConfig.config.timeout.nanos / 1e9,
        pid: fuzzerConfig.pid,
        startTime: fuzzerConfig.start_time,
        metrics: await tryConnectToDb(fuzzerConfig.config.metrics),
    });
}

async function tryConnectToDb(path: string): Promise<Database | undefined> {
    if (await fs.exists(path)) {
        return new Database(path);
    } else {
        return undefined;
    }
}

export async function collectProjectInfo(
    rootDir: string,
): Promise<ProjectInfo[]> {
    const glob = new Bun.Glob(`${rootDir}/**/project`);
    const result: ProjectInfo[] = [];
    for await (const file of glob.scan()) {
        result.push(await collectProjectInfoForDir(path.dirname(file)));
    }
    return result;
}
