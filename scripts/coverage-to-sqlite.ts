/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Collects all V8 raw block-coverage JSON files in a coverage directory
 * (the `.c8/` temp dirs that c8 leaves behind) and appends a `coverage`
 * table into an existing `metrics.db` (produced by `make-metrics-db.ts`).
 *
 * The new `coverage` table has one row per canonical branch arm per run:
 *   - branch_id  : canonical id from `branch-extract.ts` (joins to
 *                  `branches.id` in metrics.db)
 *   - run_id     : per-run id parsed from the c8 directory name
 *   - schema     : the schema name parsed from the c8 directory name
 *   - hitcount   : V8 block-coverage hit count for this arm
 *
 * Branch ids are stable across runs and across libraries — see
 * branch-extract.ts.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019df9e1-9e9f-76af-b131-a2c25384b264
 * https://ampcode.com/threads/T-019e381c-07b2-73d2-bd68-28efe38ead9e
 */

import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    joinC8ToCanonical,
    mergeScriptCoverages,
    type V8ScriptCoverage,
} from "./branch-extract.ts";

const usage =
    "usage: node --experimental-strip-types scripts/coverage-to-sqlite.ts <metrics-db> <coverage-dir>";

const metricsDbArg = process.argv[2];
const coverageDirArg = process.argv[3];
if (!metricsDbArg || !coverageDirArg) {
    console.error(usage);
    process.exit(1);
}

const dbPath = resolve(metricsDbArg);
const coverageDir = resolve(coverageDirArg);

type RunMeta = {
    library: string;
    schema: string;
    runId: number;
};

/**
 * Run-directory library prefixes are bare names (e.g. `angular_*`), but
 * the corresponding npm package and `node_modules/` path use an `@scope/`
 * prefix. Mirrors the same mapping in `scripts/common.ts#findEntryPoint`.
 */
const LIBRARY_ALIASES: Record<string, string> = {
    angular: "@angular/compiler",
    turf: "@turf/turf",
    xmldom: "@xmldom/xmldom",
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
    const [rawLibrary, mode, schema, , runIdStr] = tokens;
    if (mode !== "sequence") {
        throw new Error(
            `expected mode 'sequence' in run directory name '${name}', got '${mode}'`,
        );
    }
    const runId = Number(runIdStr);
    if (Number.isNaN(runId)) {
        throw new Error(`could not parse run id from '${name}'`);
    }
    const library = LIBRARY_ALIASES[rawLibrary] ?? rawLibrary;
    return { library, schema, runId };
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS coverage (
    branch_id TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    schema TEXT NOT NULL,
    hitcount INTEGER NOT NULL
  )
`);

const insert = db.prepare(`
  INSERT INTO coverage (branch_id, run_id, schema, hitcount)
  VALUES (?, ?, ?, ?)
`);

type PendingRow = {
    branchId: string;
    runId: number;
    schema: string;
    hitcount: number;
};

const pending: PendingRow[] = [];
let runCount = 0;
let scriptCount = 0;
let parseFailures = 0;

// Find all V8 coverage JSON files. c8 writes them into <run-dir>/.c8/.
async function findCoverageFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    let topEntries;
    try {
        topEntries = await readdir(root, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of topEntries) {
        if (!entry.isDirectory()) continue;
        const c8Dir = join(root, entry.name, ".c8");
        let c8Entries;
        try {
            c8Entries = await readdir(c8Dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const f of c8Entries) {
            if (
                f.isFile() &&
                f.name.startsWith("coverage-") &&
                f.name.endsWith(".json")
            ) {
                out.push(join(c8Dir, f.name));
            }
        }
    }
    return out;
}

const filesByRun = new Map<string, string[]>();
for (const fullPath of await findCoverageFiles(coverageDir)) {
    const runDir = basename(dirname(dirname(fullPath)));
    const arr = filesByRun.get(runDir) ?? [];
    arr.push(fullPath);
    filesByRun.set(runDir, arr);
}

for (const [runDir, files] of filesByRun) {
    const { library, schema, runId } = parseRunDir(runDir);
    runCount++;

    // Aggregate ScriptCoverage records across every dump produced by this run.
    // Restrict to files within this run's library, matching the filter that
    // `make-metrics-db.ts` uses when populating the `branches` table.
    const libraryMarker = `node_modules/${library}/`;
    const byUrl = new Map<string, V8ScriptCoverage[]>();
    for (const filePath of files) {
        const data = JSON.parse(await readFile(filePath, "utf-8")) as {
            result: V8ScriptCoverage[];
        };
        for (const script of data.result) {
            if (!script.url.startsWith("file://")) continue;
            if (!script.url.includes(libraryMarker)) continue;
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
        let rows;
        try {
            // Pass the `file://` URL as the `file` arg so the canonical
            // branch ids match the ones `make-metrics-db.ts` writes into
            // the `branches` table (which keys off the loader URL, not
            // the filesystem path).
            rows = joinC8ToCanonical(code, url, library, merged);
        } catch (err) {
            parseFailures++;
            console.warn(
                `warn: failed to extract branches from ${sourcePath}: ${(err as Error).message}`,
            );
            continue;
        }
        scriptCount++;
        for (const row of rows) {
            pending.push({
                branchId: row.id,
                runId,
                schema,
                hitcount: row.count,
            });
        }
    }
}

db.exec("BEGIN");
for (const r of pending) {
    insert.run(r.branchId, r.runId, r.schema, r.hitcount);
}
db.exec("COMMIT");

const { count } = db
    .prepare("SELECT COUNT(*) as count FROM coverage")
    .get() as { count: number };
console.assert(
    count >= pending.length,
    `expected at least ${pending.length} rows in coverage, got ${count}`,
);
console.assert(pending.length > 0, "no rows were inserted");

db.close();

console.log(
    `wrote ${pending.length} coverage rows from ${scriptCount} script(s) across ${runCount} run(s) to ${dbPath}` +
        (parseFailures > 0 ? ` (${parseFailures} parse failure(s))` : ""),
);
