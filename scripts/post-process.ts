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

let errorCount = 0;

namespace log {
    export function error(...args: unknown[]): void {
        errorCount++;
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

async function forEachRun(
    dir: string,
    skip: Set<string>,
    fn: (subdirName: string, subdirPath: string) => Promise<void>,
) {
    if (skip.size > 0) {
        log.warn("skipping panics");
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const subdirs = entries.filter((e) => e.isDirectory() && !skip.has(e.name));
    for (const subdir of subdirs) {
        await fn(subdir.name, join(dir, subdir.name));
    }
}

const EXPECTED_FILES = [
    "heartbeat.csv",
    "timeout",
    "fuzzer-config.json",
    "logs.txt",
];

async function assertExpectedFiles(dir: string, skip: Set<string>) {
    await forEachRun(dir, skip, async (name, subdirPath) => {
        for (const file of EXPECTED_FILES) {
            const path = join(subdirPath, file);
            try {
                const s = await stat(path);
                if (s.size === 0) {
                    log.error(`empty ${file}: ${name}`);
                }
            } catch {
                log.error(`missing ${file}: ${name}`);
            }
        }
    });
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
    await forEachRun(dir, skip, async (name, subdirPath) => {
        const logsPath = join(subdirPath, "logs.txt");
        const timeoutPath = join(subdirPath, "timeout");

        let timeoutMinutes: number;
        try {
            const timeoutSeconds = Number(
                (await readFile(timeoutPath, "utf-8")).trim(),
            );
            timeoutMinutes = timeoutSeconds / 60;
        } catch {
            return;
        }

        const result =
            await $`rg -oN 'run time: [\dhms-]+' ${logsPath} | tail -1`
                .nothrow()
                .quiet();
        const lastMatch = result.text().trim();
        if (!lastMatch) {
            log.error(`no run time found in logs: ${name}`);
            return;
        }

        const lastRunTime = lastMatch.replace("run time: ", "");

        const runMinutes = parseRunTime(lastRunTime);
        if (timeoutMinutes - runMinutes > COMPLETION_THRESHOLD_MINUTES) {
            log.error(
                `incomplete run: ${name} (ran ${lastRunTime}, expected ${timeoutMinutes}m)`,
            );
        }
    });
}

async function assertCorpusInvariants(dir: string, skip: Set<string>) {
    await forEachRun(dir, skip, async (name, subdirPath) => {
        const corpusDir = join(subdirPath, "corpus");
        let corpusEntries: string[];
        try {
            corpusEntries = await readdir(corpusDir);
        } catch {
            log.error(`missing corpus directory: ${name}`);
            return;
        }

        const inputs = corpusEntries.filter((e) => !e.startsWith("."));

        for (const input of inputs) {
            const metadataFile = join(corpusDir, `.${input}_1.metadata`);
            let raw: string;
            try {
                raw = await readFile(metadataFile, "utf-8");
            } catch {
                log.error(`missing metadata for input ${input}: ${name}`);
                continue;
            }

            const parsed = JSON.parse(raw);
            const map = parsed.metadata?.map;
            if (!map) {
                log.error(`malformed metadata for input ${input}: ${name}`);
                continue;
            }

            for (const [, value] of Object.entries<
                [unknown, { is_valid?: boolean; throws?: boolean }]
            >(map)) {
                const isValid = value[1].is_valid;
                const throws = value[1].throws;
                if (isValid === throws) {
                    log.error(
                        `invariant violation (is_valid=${isValid}, throws=${throws}) for input ${input}: ${name}`,
                    );
                }
            }
        }
    });
}

async function assertCrashInvariants(dir: string, skip: Set<string>) {
    return forEachRun(dir, skip, async (name) => {
        const crashDir = join(dir, name, "crashes");
        let crashEntries: string[];
        try {
            crashEntries = await readdir(crashDir);
        } catch {
            return;
        }

        const inputs = crashEntries.filter((e) => !e.startsWith("."));

        for (const input of inputs) {
            const metadataFile = join(crashDir, `.${input}_1.metadata`);
            let raw: string;
            try {
                raw = await readFile(metadataFile, "utf-8");
            } catch {
                log.error(`missing metadata for crash ${input}: ${name}`);
                continue;
            }

            const parsed = JSON.parse(raw);
            const map = parsed.metadata?.map;
            if (!map) {
                log.error(`malformed metadata for crash ${input}: ${name}`);
                continue;
            }

            for (const [, value] of Object.entries<[unknown, unknown]>(map)) {
                const meta = value[1];
                if (meta === "Timeout") {
                    continue;
                }
                if (typeof meta !== "object" || meta === null) {
                    log.error(
                        `unexpected metadata format for crash ${input}: ${name}`,
                    );
                    continue;
                }
                const { is_valid: isValid, throws: threw } = meta as {
                    is_valid?: boolean;
                    throws?: boolean;
                };
                if (!isValid) {
                    log.error(
                        `crash reported for invalid input ${input}: ${name}`,
                    );
                }
                if (!threw) {
                    log.error(
                        `crash did not throw for input ${input}: ${name}`,
                    );
                }
            }
        }
    });
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

async function assertDbExists(dir: string) {
    if (!(await Bun.file(join(dir, "heartbeat.db")).exists())) {
        log.error("missing heartbeat.db");
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

    log.section("checking", "corpus invariants");
    await assertCorpusInvariants(dir, panicked);

    log.section("checking", "crash invariants");
    await assertCrashInvariants(dir, panicked);

    if (CREATE_DB) {
        log.section("creating", "heartbeat.db");
        await heartbeatToSqlite(dir);
    }

    log.section("checking", "heartbeat.db")
    await assertDbExists(dir);

    if (errorCount > 0) {
        log.section("result", `${errorCount} error(s) found`);
        process.exit(1);
    }
}

main();
