import path from "node:path";
import fs from "node:fs/promises";
import { getProjectNames, type Project } from "./common";
import type { Schema } from "@railcar/inference";
import { countObjectPropertyAccessesInFile } from "./analyzers/property-accesses";

const RAILCAR_ROOT = path.dirname(import.meta.dirname);

type Row = {
    project: Project;
    size?: number;
    propertyAccesses?: number;
    inputValidationComplexity?: number;
    higherOrderFunctions?: number;
    inputUsageComplexity?: number;
};

/**
 * Return the number of higher-order functions in the schema.
 *
 * A higher-order function is a function that receives or returns a function.
 */
function analyzeHigherOrderFunctions(schema: Schema): number {
    let count = 0;
    for (const sg of Object.values(schema)) {
        if (sg.ret.kind.Function) {
            count++;
            continue;
        }

        for (const arg of sg.args) {
            if (arg.kind.Function) {
                count++;
                break;
            }
        }
    }
    return count;
}

/**
 * Count the number of endpoints in the schema, excluding built-ins.
 */
function analyzeApiSize(schema: Schema): number {
    let total = 0;
    for (const sg of Object.values(schema)) {
        if (sg.builtin) continue;
        total += 1;
    }
    return total;
}

async function analyzePropertyAccesses(
    _: Project,
    bundle: string,
): Promise<number> {
    return countObjectPropertyAccessesInFile(bundle);
}

async function analyze(project: Project, bundle: string): Promise<Row> {
    const schemaFile = `${RAILCAR_ROOT}/examples/${project}/typescript.json`;
    const schema: Schema = await Bun.file(schemaFile).json();

    const size = analyzeApiSize(schema);
    const higherOrderFunctions = analyzeHigherOrderFunctions(schema);

    const propertyAccesses = await analyzePropertyAccesses(project, bundle);
    const inputValidationComplexity = Math.floor(Math.random() * 1000);
    const inputUsageComplexity = Math.floor(Math.random() * 1000);
    return {
        project,
        size,
        propertyAccesses,
        inputValidationComplexity,
        higherOrderFunctions,
        inputUsageComplexity,
    };
}

function printCsv(rows: Row[]) {
    console.log(
        "project,property_accesses,input_validation_complexity,higher_order_functions,input_usage_complexity",
    );
    for (const row of rows) {
        console.log(
            `${row.project},${row.propertyAccesses ?? ""},${row.inputValidationComplexity ?? ""},${row.higherOrderFunctions ?? ""},${row.inputUsageComplexity ?? ""}`,
        );
    }
}

type Args = {
    bundleDir: string;
    csv: boolean;
};

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        console.error(
            "Usage: bun run analyze-libraries.ts [--csv] <bundle-dir>",
        );
        process.exit(1);
    }

    let csv = false;
    let bundleDir = "";
    let i = 0;
    while (i < argv.length) {
        const arg = argv[i];
        if (arg === "--csv") {
            csv = true;
        } else {
            bundleDir = arg;
        }
        i++;
    }

    if (bundleDir === "") {
        console.error("Missing bundle dir");
        console.error(
            "Usage: bun run analyze-libraries.ts [--csv] <bundle-dir>",
        );
        process.exit(1);
    }

    return { bundleDir, csv };
}

async function main() {
    const args = parseArgs();

    if (!(await fs.exists(args.bundleDir))) {
        console.error(`Bundle directory '${args.bundleDir}' does not exist.`);
        process.exit(1);
    }

    const rows: Row[] = [];
    for (const project of getProjectNames()) {
        console.log(project);

        const bundle = path.join(args.bundleDir, `${project}.bundle.js`);
        if (await fs.exists(bundle)) {
            const row = await analyze(project, bundle);
            rows.push(row);
        } else {
            console.warn(`[WARN] No bundle found for ${project}. Skipping.`);
        }
    }

    if (args.csv) {
        printCsv(rows);
    } else {
        console.table(rows);
    }
}

main();
