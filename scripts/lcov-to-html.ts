/**
 * Generated with Amp
 * https://ampcode.com/threads/T-019d8df7-62c7-7768-a75a-bff79e3f260e
 * https://ampcode.com/threads/T-019dac8a-ebcc-72dc-9f40-cdb8016350ea
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import { type BranchData, type LcovFile, parseLcov } from "./lcov.ts";

function usage() {
    console.log("Usage: lcov-to-html <lcov-file> [--out <dir>]");
    exit(0);
}

function toIstanbulCoverage(files: LcovFile[]) {
    const coverage = {};

    for (const file of files) {
        const statementMap = {};
        const s = {};
        const branchMap = {};
        const b = {};
        const fnMap = {};
        const f = {};

        // Statements from DA lines
        for (let i = 0; i < file.lines.length; i++) {
            const { line, count } = file.lines[i];
            statementMap[String(i)] = {
                start: { line, column: 0 },
                end: { line, column: Number.MAX_SAFE_INTEGER },
            };
            s[String(i)] = count;
        }

        // Branches from BRDA lines, grouped by (line, block)
        const branchGroups = new Map<
            string,
            { line: number; block: number; exprs: BranchData[] }
        >();
        for (const br of file.branches) {
            const key = `${br.line}:${br.block}`;
            if (!branchGroups.has(key)) {
                branchGroups.set(key, {
                    line: br.line,
                    block: br.block,
                    exprs: [],
                });
            }
            assert(branchGroups.get(key) !== undefined);
            branchGroups.get(key)!.exprs.push(br);
        }
        let brIdx = 0;
        for (const [, group] of branchGroups) {
            const locations = group.exprs.map((e) => ({
                start: { line: group.line, column: e.expr },
                end: { line: group.line, column: e.expr + 1 },
            }));
            branchMap[String(brIdx)] = {
                type: "if",
                loc: {
                    start: { line: group.line, column: 0 },
                    end: { line: group.line, column: Number.MAX_SAFE_INTEGER },
                },
                locations,
                line: group.line,
            };
            b[String(brIdx)] = group.exprs.map((e) => e.count);
            brIdx++;
        }

        // Functions from FN + FNDA
        const fnCountMap = new Map();
        for (const fd of file.fnData) {
            fnCountMap.set(fd.name, fd.count);
        }
        for (let i = 0; i < file.functions.length; i++) {
            const fn = file.functions[i];
            fnMap[String(i)] = {
                name: fn.name,
                decl: {
                    start: { line: fn.line, column: 0 },
                    end: { line: fn.line, column: Number.MAX_SAFE_INTEGER },
                },
                loc: {
                    start: { line: fn.line, column: 0 },
                    end: { line: fn.line, column: Number.MAX_SAFE_INTEGER },
                },
                line: fn.line,
            };
            f[String(i)] = fnCountMap.get(fn.name) ?? 0;
        }

        coverage[file.path] = {
            path: file.path,
            statementMap,
            fnMap,
            branchMap,
            s,
            f,
            b,
        };
    }

    return coverage;
}

// Parse args
const args = argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    usage();
}

let lcovPath: string | null = null;
let outDir = resolve("coverage/html");

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && i + 1 < args.length) {
        outDir = resolve(args[++i]);
    } else if (!args[i].startsWith("-")) {
        lcovPath = resolve(args[i]);
    } else {
        console.error(`Unknown option: ${args[i]}`);
        exit(1);
    }
}

if (!lcovPath) {
    console.error("Error: no lcov file specified");
    exit(1);
}

const content = readFileSync(lcovPath, "utf-8");
const files = parseLcov(content);
console.log(`Parsed ${files.length} file(s) from ${lcovPath}`);

const istanbulData = toIstanbulCoverage(files);
const map = libCoverage.createCoverageMap(istanbulData);

const context = libReport.createContext({
    dir: outDir,
    coverageMap: map,
});

const htmlReport = reports.create("html", {});
htmlReport.execute(context);

console.log(`HTML coverage report written to ${outDir}`);
