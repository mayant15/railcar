/**
 * Given a `infra/fuzz.py` output directory, run some integrity checks and
 * post-processing for analysis.
 *
 * Tries to report all errors. Only exits early if no further analysis can
 * be done.
 */

import { $ } from "bun";
import { readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import yo from "yoctocolors";

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

async function assertNoPanics(dir: string) {
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
        }
    }
}

async function assertHeartbeats(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory());
    for (const subdir of subdirs) {
        const heartbeat = join(dir, subdir.name, "heartbeat.csv");
        try {
            const s = await stat(heartbeat);
            if (s.size === 0) {
                log.error(`empty heartbeat: ${heartbeat}`);
            }
        } catch {
            log.error(`missing heartbeat: ${heartbeat}`);
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
    await assertNoPanics(dir);

    log.section("checking", "heartbeats");
    await assertHeartbeats(dir);

    await heartbeatToSqlite(dir);

    console.log(dir);
}

main();
