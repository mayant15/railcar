/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Collects all V8 raw block-coverage JSON files in a coverage directory
 * (the `.c8/` temp dirs that c8 leaves behind) and writes one row per
 * canonical branch arm into a SQLite database. Branch IDs are stable
 * across runs and across libraries — see branch-extract.ts.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019df9e1-9e9f-76af-b131-a2c25384b264
 */

import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type CanonicalCoverageRow,
    joinC8ToCanonical,
    mergeScriptCoverages,
    type V8ScriptCoverage,
} from "./branch-extract.ts";

const usage = "usage: bun scripts/coverage-to-sqlite.ts <coverage-dir>";

const dir = process.argv[2];
if (!dir) {
    console.error(usage);
    process.exit(1);
}

const coverageDir = resolve(dir);
const dbPath = join(coverageDir, "coverage.db");

type RunMeta = {
    library: string;
    schema: string;
    runId: number;
};

/**
 * Run directory names follow the pattern:
 *   {library}_sequence_{schema}_{entrypoint}_{runId}
 * Library names do not contain underscores (hyphens are allowed).
 */
function parseRunDir(name: string): RunMeta {
    const tokens = name.split("_");
    if (tokens.length !== 5) {
        throw new Error(`unexpected run directory name: ${name}`);
    }
    const [library, mode, schema, , runIdStr] = tokens;
    if (mode !== "sequence") {
        throw new Error(
            `expected mode 'sequence' in run directory name '${name}', got '${mode}'`,
        );
    }
    const runId = Number(runIdStr);
    if (Number.isNaN(runId)) {
        throw new Error(`could not parse run id from '${name}'`);
    }
    return { library, schema, runId };
}

const db = new Database(dbPath);
db.run("PRAGMA journal_mode = WAL");

db.run(`
  CREATE TABLE IF NOT EXISTS branches (
    canonical_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    function_name TEXT,
    kind TEXT NOT NULL,
    arm_index INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    run_id INTEGER NOT NULL,
    schema TEXT NOT NULL,
    library TEXT NOT NULL,
    hitcount INTEGER NOT NULL,
    matched INTEGER NOT NULL,
    continuation INTEGER NOT NULL
  )
`);

const insert = db.prepare(`
  INSERT INTO branches (
    canonical_id, file_path, function_name, kind, arm_index,
    start_line, start_col, run_id, schema, library,
    hitcount, matched, continuation
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

type PendingRow = CanonicalCoverageRow & {
    runId: number;
    schema: string;
    library: string;
};

const pending: PendingRow[] = [];
let runCount = 0;
let scriptCount = 0;
let parseFailures = 0;

// Find all V8 coverage JSON files. c8 writes them into <run-dir>/.c8/.
const glob = new Glob("*/.c8/coverage-*.json");

const filesByRun = new Map<string, string[]>();
for await (const path of glob.scan({ cwd: coverageDir, dot: true })) {
    const fullPath = join(coverageDir, path);
    const runDir = basename(dirname(dirname(fullPath)));
    const arr = filesByRun.get(runDir) ?? [];
    arr.push(fullPath);
    filesByRun.set(runDir, arr);
}

for (const [runDir, files] of filesByRun) {
    const { library, schema, runId } = parseRunDir(runDir);
    runCount++;

    // Aggregate ScriptCoverage records across every dump produced by this run.
    const byUrl = new Map<string, V8ScriptCoverage[]>();
    for (const filePath of files) {
        const data = JSON.parse(await Bun.file(filePath).text()) as {
            result: V8ScriptCoverage[];
        };
        for (const script of data.result) {
            if (!script.url.startsWith("file://")) continue;
            const arr = byUrl.get(script.url) ?? [];
            arr.push(script);
            byUrl.set(script.url, arr);
        }
    }

    for (const [url, scripts] of byUrl) {
        const merged = mergeScriptCoverages(scripts);
        let sourcePath: string;
        try {
            sourcePath = fileURLToPath(url);
        } catch {
            continue;
        }
        let code: string;
        try {
            code = await readFile(sourcePath, "utf-8");
        } catch {
            continue;
        }
        let rows: CanonicalCoverageRow[];
        try {
            rows = joinC8ToCanonical(code, sourcePath, merged);
        } catch (err) {
            parseFailures++;
            console.warn(
                `warn: failed to extract branches from ${sourcePath}: ${(err as Error).message}`,
            );
            continue;
        }
        scriptCount++;
        for (const row of rows) {
            pending.push({ ...row, runId, schema, library });
        }
    }
}

const insertAll = db.transaction((rows: PendingRow[]) => {
    for (const r of rows) {
        insert.run(
            r.id,
            r.file,
            r.functionName,
            r.kind,
            r.armIndex,
            r.startLine,
            r.startCol,
            r.runId,
            r.schema,
            r.library,
            r.count,
            r.matched ? 1 : 0,
            r.continuation ? 1 : 0,
        );
    }
});

insertAll(pending);

const { count } = db.query("SELECT COUNT(*) as count FROM branches").get() as {
    count: number;
};
console.assert(
    count === pending.length,
    `expected ${pending.length} rows in db, got ${count}`,
);
console.assert(count > 0, "no rows were inserted");

db.close();

console.log(
    `wrote ${pending.length} branch rows from ${scriptCount} script(s) across ${runCount} run(s) to ${dbPath}` +
        (parseFailures > 0 ? ` (${parseFailures} parse failure(s))` : ""),
);
