/**
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e380b-bf89-736d-8d78-fe3fb2d751f7
 */

import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import { unlinkSync, existsSync } from "node:fs";
import {
    extract,
    type BranchArm,
    type FunctionAttr,
} from "./branch-extract.ts";

async function analyzeProject(
    project: string,
    entrypoint: string,
): Promise<{ branches: BranchArm[]; functions: FunctionAttr[] }> {
    const branches: BranchArm[] = [];
    const functions: FunctionAttr[] = [];
    const hooks = registerHooks({
        load(url, context, nextLoad) {
            const def = nextLoad(url, context);
            if (!def.format) {
                console.warn("missing format info for", url);
                return def;
            }

            const shouldAnalyze =
                (def.format.startsWith("commonjs") ||
                    def.format.startsWith("module")) &&
                url.includes(`node_modules/${project}`);

            if (!shouldAnalyze) {
                console.warn("skipping", url);
                return def;
            }

            if (!def.source) {
                console.warn("missing source for", url);
                return def;
            }

            console.log("analyzing", url);
            const code = def.source.toString();
            const result = extract(code, url, project);

            // This used to be a single push, with `branches.push(...result.branches)`.
            // That throws a `RangeError: Maximum call stack size exceeded` when there
            // are too many branches (e.g. typescript).
            for (const b of result.branches) branches.push(b);
            for (const f of result.functions) functions.push(f);

            return def;
        },
    });

    // NOTE: Since imports are cached, this script assumes that each library has its
    // own distinct set of files we're interested in. If there's a module that is shared
    // by two libraries, only the first import will run Babel. This assumption holds for
    // us, since we're only interested in a library's direct sources.
    await import(entrypoint);

    hooks.deregister();

    return { branches, functions };
}

async function main() {
    const projects = [
        "@angular/compiler",
        "fast-xml-parser",
        "jpeg-js",
        "protobufjs",
        "sharp",
        "@turf/turf",
        "xml2js",
        "jimp",
        "js-yaml",
        "lit",
        "lodash",
        "pako",
        "redux",
        "tslib",
        "typescript",
        "@xmldom/xmldom",
    ];

    const dbPath = "metrics.db";
    if (existsSync(dbPath)) unlinkSync(dbPath);
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");

    // NOTE: `id` is NOT a primary key on `branches`. The canonical id is a
    // hash of (file, kind, location, armIndex), and zero-width "continuation"
    // arms for different `If`/`Loop`/`Try` constructs that end at the same
    // byte share the same id. (V8 would assign them the same count too.)
    db.exec(`
        CREATE TABLE branches (
            id TEXT NOT NULL,
            file TEXT NOT NULL,
            kind TEXT NOT NULL,
            arm_index INTEGER NOT NULL,
            start_line INTEGER NOT NULL,
            start_col INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            end_col INTEGER NOT NULL,
            start_offset INTEGER NOT NULL,
            end_offset INTEGER NOT NULL,
            continuation INTEGER NOT NULL,
            function_id TEXT NOT NULL,
            library TEXT NOT NULL
        )
    `);

    db.exec(`
        CREATE TABLE functions (
            id TEXT PRIMARY KEY,
            file TEXT NOT NULL,
            library TEXT NOT NULL,
            name TEXT,
            type TEXT NOT NULL,
            async INTEGER NOT NULL,
            generator INTEGER NOT NULL,
            params INTEGER NOT NULL,
            start_line INTEGER NOT NULL,
            start_col INTEGER NOT NULL,
            end_line INTEGER NOT NULL,
            end_col INTEGER NOT NULL,
            start_offset INTEGER NOT NULL,
            end_offset INTEGER NOT NULL
        )
    `);

    const insertBranch = db.prepare(`
        INSERT INTO branches (
            id, file, kind, arm_index, start_line, start_col,
            end_line, end_col, start_offset, end_offset,
            continuation, function_id, library
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFunction = db.prepare(`
        INSERT INTO functions (
            id, file, library, name, type, async, generator, params,
            start_line, start_col, end_line, end_col,
            start_offset, end_offset
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalBranches = 0;
    let totalFunctions = 0;

    for (const project of projects) {
        const entrypoint = new URL(import.meta.resolve(project)).pathname;
        const { branches, functions } = await analyzeProject(
            project,
            entrypoint,
        );

        db.exec("BEGIN");
        for (const b of branches) {
            insertBranch.run(
                b.id,
                b.file,
                b.kind,
                b.armIndex,
                b.startLine,
                b.startCol,
                b.endLine,
                b.endCol,
                b.startOffset,
                b.endOffset,
                b.continuation ? 1 : 0,
                b.functionId,
                b.library,
            );
        }
        for (const f of functions) {
            insertFunction.run(
                f.id,
                f.file,
                f.library,
                f.name,
                f.type,
                f.async ? 1 : 0,
                f.generator ? 1 : 0,
                f.params,
                f.startLine,
                f.startCol,
                f.endLine,
                f.endCol,
                f.startOffset,
                f.endOffset,
            );
        }
        db.exec("COMMIT");

        totalBranches += branches.length;
        totalFunctions += functions.length;
        console.log(
            `inserted ${branches.length} branches and ${functions.length} functions for ${project}`,
        );
    }

    const branchCount = (
        db.prepare("SELECT COUNT(*) AS count FROM branches").get() as {
            count: number;
        }
    ).count;
    const functionCount = (
        db.prepare("SELECT COUNT(*) AS count FROM functions").get() as {
            count: number;
        }
    ).count;
    assert.strictEqual(
        branchCount,
        totalBranches,
        `expected ${totalBranches} branch rows, got ${branchCount}`,
    );
    assert.strictEqual(
        functionCount,
        totalFunctions,
        `expected ${totalFunctions} function rows, got ${functionCount}`,
    );

    db.close();

    console.log(
        `wrote ${totalBranches} branches and ${totalFunctions} functions to ${dbPath}`,
    );
}

main();
