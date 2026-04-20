/**
 * Compute the coverage difference between two lcov.info files.
 *
 * Outputs a new lcov.info on stdout containing only coverage present in
 * the second file ("new") but not the first ("base"). Compose with
 * lcov-to-html.ts to generate an HTML report:
 *
 *   bun scripts/lcov-diff.ts base.info new.info > diff.info
 *   bun scripts/lcov-to-html.ts diff.info --out coverage/diff-html
 *
 * Generated with Amp
 * https://ampcode.com/threads/T-019dac8a-ebcc-72dc-9f40-cdb8016350ea
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { type LcovFile, formatLcov, parseLcov } from "./lcov.ts";

function usage() {
    console.error(
        "Usage: lcov-diff <base.info> <new.info>\n\nOutputs lcov data for coverage in <new> but not <base>.",
    );
    exit(1);
}

const args = argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length < 2) {
    usage();
}

const basePath = resolve(args[0]);
const newPath = resolve(args[1]);

const baseFiles = parseLcov(readFileSync(basePath, "utf-8"));
const newFiles = parseLcov(readFileSync(newPath, "utf-8"));

const baseByPath = new Map<string, LcovFile>();
for (const f of baseFiles) {
    baseByPath.set(f.path, f);
}

const result: LcovFile[] = [];

for (const newFile of newFiles) {
    const baseFile = baseByPath.get(newFile.path);

    // Lines: keep lines covered in new but not in base
    const baseLines = new Map<number, number>();
    if (baseFile) {
        for (const l of baseFile.lines) {
            baseLines.set(l.line, l.count);
        }
    }
    const diffLines = newFile.lines.map((l) => ({
        line: l.line,
        count: l.count > 0 && (baseLines.get(l.line) ?? 0) === 0 ? l.count : 0,
    }));

    // Branches: keep branches covered in new but not in base
    const baseBranches = new Map<string, number>();
    if (baseFile) {
        for (const br of baseFile.branches) {
            baseBranches.set(`${br.line}:${br.block}:${br.expr}`, br.count);
        }
    }
    const diffBranches = newFile.branches.map((br) => {
        const baseCount =
            baseBranches.get(`${br.line}:${br.block}:${br.expr}`) ?? 0;
        return {
            ...br,
            count: br.count > 0 && baseCount === 0 ? br.count : 0,
        };
    });

    // Functions: keep functions covered in new but not in base
    const baseFnCounts = new Map<string, number>();
    if (baseFile) {
        for (const fd of baseFile.fnData) {
            baseFnCounts.set(fd.name, fd.count);
        }
    }
    const diffFnData = newFile.fnData.map((fd) => ({
        name: fd.name,
        count:
            fd.count > 0 && (baseFnCounts.get(fd.name) ?? 0) === 0
                ? fd.count
                : 0,
    }));

    // Only emit files that have at least some unique coverage
    const hasLines = diffLines.some((l) => l.count > 0);
    const hasBranches = diffBranches.some((br) => br.count > 0);
    const hasFunctions = diffFnData.some((fd) => fd.count > 0);

    if (hasLines || hasBranches || hasFunctions) {
        result.push({
            path: newFile.path,
            lines: diffLines,
            branches: diffBranches,
            functions: newFile.functions,
            fnData: diffFnData,
        });
    }
}

process.stdout.write(formatLcov(result));
