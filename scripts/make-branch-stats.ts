import assert from "node:assert";
import { basename } from "node:path";
import { registerHooks } from "node:module";
import { writeFile } from "node:fs/promises";
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
            branches.push(...result.branches);
            functions.push(...result.functions);

            return def;
        },
    });

    await import(entrypoint);
    hooks.deregister();

    return { branches, functions };
}

function csvEscape(value: unknown): string {
    if (value == null) return "";
    const s = String(value);
    if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function toCSV<T extends Record<string, unknown>>(rows: T[]): string {
    assert(rows.length > 0);
    const columns = Object.keys(rows[0]);
    let str = columns.join(",");
    for (const row of rows) {
        str += "\n" + columns.map((col) => csvEscape(row[col])).join(",");
    }
    return str;
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

    for (const project of projects) {
        const entrypoint = new URL(import.meta.resolve(project)).pathname;
        const { branches, functions } = await analyzeProject(
            project,
            entrypoint,
        );

        const name = basename(project);
        await writeFile(`branches-${name}.csv`, toCSV(branches));
        await writeFile(`functions-${name}.csv`, toCSV(functions));
    }
}

main();
