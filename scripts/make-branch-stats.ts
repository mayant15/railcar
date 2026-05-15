import assert from "node:assert";
import { basename } from "node:path";
import { registerHooks } from "node:module";
import { writeFile } from "node:fs/promises";
import { extractBranches, type BranchArm } from "./branch-extract.ts";

async function analyzeProject(
    project: string,
    entrypoint: string,
): Promise<BranchArm[]> {
    const branches: BranchArm[] = [];
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
            branches.push(...extractBranches(code, url, project));

            return def;
        },
    });

    await import(entrypoint);
    hooks.deregister();

    return branches;
}

function toCSV(branches: BranchArm[]): string {
    assert(branches.length > 0);
    const columns = Object.keys(branches[0]);
    let str = columns.join(",");
    for (const branch of branches) {
        str += "\n" + columns.map((col) => branch[col]).join(",");
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
        const branches = await analyzeProject(project, entrypoint);

        const csv = toCSV(branches);
        await writeFile(`branches-${basename(project)}.csv`, csv);
    }
}

main();
