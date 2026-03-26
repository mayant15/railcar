/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Collects all heartbeat.csv files in a given directory and combines them into
 * an SQLite database.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019d2612-9db8-772d-b5d8-a9f8650b4044
 *
 */

import { Database } from "bun:sqlite";
import { Glob } from "bun";
import { basename, join, resolve } from "node:path";

const usage = "usage: bun scripts/heartbeat-to-sqlite.ts <results-dir>";

const dir = process.argv[2];
if (!dir) {
    console.error(usage);
    process.exit(1);
}

const resultsDir = resolve(dir);
const dbPath = join(resultsDir, "heartbeat.db");

const db = new Database(dbPath);
db.run("PRAGMA journal_mode = WAL");

db.run(`
  CREATE TABLE IF NOT EXISTS heartbeat (
    run TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    objectives INTEGER NOT NULL,
    execs INTEGER NOT NULL,
    corpus INTEGER NOT NULL,
    coverage INTEGER NOT NULL,
    valid_execs INTEGER NOT NULL,
    valid_corpus INTEGER NOT NULL,
    valid_coverage INTEGER NOT NULL,
    total_edges INTEGER NOT NULL,
    labels TEXT NOT NULL
  )
`);

const insert = db.prepare(`
  INSERT INTO heartbeat (run, timestamp, objectives, execs, corpus, coverage, valid_execs, valid_corpus, valid_coverage, total_edges, labels)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const glob = new Glob("*/heartbeat.csv");
let totalRows = 0;

type Row = { run: string; lines: string[] };
const rows: Row[] = [];

for await (const path of glob.scan(resultsDir)) {
    const fullPath = join(resultsDir, path);
    const run = basename(join(resultsDir, path, ".."));
    const text = await Bun.file(fullPath).text();
    rows.push({ run, lines: text.split("\n") });
}

const insertAll = db.transaction((rows: Row[]) => {
    for (const { run, lines } of rows) {
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Parse CSV with quoted labels field: the last field is quoted and contains commas
            const match = line.match(
                /^(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+),"(.+)"$/,
            );
            if (!match) {
                console.warn(`skipping malformed line: ${line}`);
                continue;
            }

            const [
                ,
                timestamp,
                objectives,
                execs,
                corpus,
                coverage,
                validExecs,
                validCorpus,
                validCoverage,
                totalEdges,
                labels,
            ] = match;
            insert.run(
                run,
                Number(timestamp),
                Number(objectives),
                Number(execs),
                Number(corpus),
                Number(coverage),
                Number(validExecs),
                Number(validCorpus),
                Number(validCoverage),
                Number(totalEdges),
                labels,
            );
            totalRows++;
        }
    }
});

insertAll(rows);

const { count } = db.query("SELECT COUNT(*) as count FROM heartbeat").get() as {
    count: number;
};
console.assert(
    count === totalRows,
    `expected ${totalRows} rows in db, got ${count}`,
);
console.assert(count > 0, "no rows were inserted");

const distinctRuns = db
    .query("SELECT COUNT(DISTINCT run) as count FROM heartbeat")
    .get() as { count: number };
console.assert(
    distinctRuns.count === rows.length,
    `expected ${rows.length} distinct runs, got ${distinctRuns.count}`,
);

db.close();

console.log(`wrote ${totalRows} rows from ${rows.length} runs to ${dbPath}`);
