/**
 * Given a `infra/fuzz.py` output directory, run some integrity checks and
 * post-processing for analysis.
 *
 * Tries to report all errors. Only exits early if no further analysis can
 * be done.
 *
 * Generated with Amp.
 */

import { $ } from "bun";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import yo from "yoctocolors";

// TODO: Toggle this once done testing. For now, it is more convenient to not
// touch the existing database.
const CREATE_DB = false;

const COMPLETION_THRESHOLD_MINUTES = 5;

namespace log {
    export function error(...args: unknown[]): void {
        console.log(yo.red(yo.bold("error:")), ...args);
    }

    export function warn(...args: unknown[]): void {
        console.log(yo.yellow(yo.bold("warning:")), ...args);
    }

    export function fatal(...args: unknown[]): never {
        error(...args);
        process.exit(1);
    }

    export function section(header: string, msg?: string) {
        console.log("");
        console.log("=======================================================");
        console.log(yo.green(yo.bold(`${header}`)), msg);
        console.log("");
    }
}

async function assertDirectory(path: string): Promise<void> {
    try {
        const s = await stat(path);
        if (!s.isDirectory()) {
            log.fatal(`not a directory: ${path}`);
        }
    } catch {
        log.fatal(`directory does not exist: ${path}`);
    }
}

async function assertNoPanics(dir: string): Promise<Set<string>> {
    const panicked = new Set<string>();
    const result = await $`rg -l panic ${dir}`.nothrow().quiet();
    if (result.exitCode === 0) {
        const files = result.text().trim().split("\n");
        for (const f of files) {
            if (basename(f) !== "logs.txt") {
                log.fatal(`unexpected panic outside logs.txt: ${f}`);
            }
        }
        const dirs = [...new Set(files.map((f) => basename(dirname(f))))];
        for (const d of dirs) {
            log.error(`panic: ${d}`);
            panicked.add(d);
        }
    }
    return panicked;
}

const EXPECTED_FILES = [
    "heartbeat.csv",
    "timeout",
    "fuzzer-config.json",
    "logs.txt",
];

async function assertExpectedFiles(dir: string, skip: Set<string>) {
    if (skip.size > 0) {
        log.warn("skipping panics");
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory() && !skip.has(e.name));
    for (const subdir of subdirs) {
        for (const file of EXPECTED_FILES) {
            const path = join(dir, subdir.name, file);
            try {
                const s = await stat(path);
                if (s.size === 0) {
                    log.error(`empty ${file}: ${subdir.name}`);
                }
            } catch {
                log.error(`missing ${file}: ${subdir.name}`);
            }
        }
    }
}

function parseRunTime(runTime: string): number {
    let minutes = 0;
    const hours = runTime.match(/(\d+)h/);
    const mins = runTime.match(/(\d+)m/);
    const secs = runTime.match(/(\d+)s/);
    if (hours) minutes += Number(hours[1]) * 60;
    if (mins) minutes += Number(mins[1]);
    if (secs) minutes += Number(secs[1]) / 60;
    return minutes;
}

async function assertCompleted(dir: string, skip: Set<string>) {
    if (skip.size > 0) {
        log.warn("skipping panics");
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory() && !skip.has(e.name));
    for (const subdir of subdirs) {
        const logsPath = join(dir, subdir.name, "logs.txt");
        const timeoutPath = join(dir, subdir.name, "timeout");

        let timeoutMinutes: number;
        try {
            timeoutMinutes = Number(
                (await readFile(timeoutPath, "utf-8")).trim(),
            );
        } catch {
            continue;
        }

        const result =
            await $`rg -oN 'run time: [\dhms-]+' ${logsPath} | tail -1`
                .nothrow()
                .quiet();
        const lastMatch = result.text().trim();
        if (!lastMatch) {
            log.error(`no run time found in logs: ${subdir.name}`);
            continue;
        }

        const lastRunTime = lastMatch.replace("run time: ", "");

        const runMinutes = parseRunTime(lastRunTime);
        if (timeoutMinutes - runMinutes > COMPLETION_THRESHOLD_MINUTES) {
            log.error(
                `incomplete run: ${subdir.name} (ran ${lastRunTime}, expected ${timeoutMinutes}m)`,
            );
        }
    }
}

async function heartbeatToSqlite(dir: string) {
    const dbPath = join(dir, "heartbeat.db");
    try {
        await stat(dbPath);
        log.warn(`deleting existing database: ${dbPath}`);
        await unlink(dbPath);
    } catch {
        // doesn't exist, nothing to delete
    }

    const script = join(import.meta.dir, "heartbeat-to-sqlite.ts");
    const proc = Bun.spawn(["bun", script, dir], {
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        log.fatal(`heartbeat-to-sqlite failed with exit code ${exitCode}`);
    }
}

async function main() {
    const dir = process.argv[2];
    if (!dir) {
        log.fatal("Usage: post-process <directory>");
    }

    await assertDirectory(dir);

    log.section("checking", "panics");
    const panicked = await assertNoPanics(dir);

    log.section("checking", "expected files");
    await assertExpectedFiles(dir, panicked);

    log.section("checking", "completion");
    await assertCompleted(dir, panicked);

    if (CREATE_DB) {
        await heartbeatToSqlite(dir);
    }
}

main();
