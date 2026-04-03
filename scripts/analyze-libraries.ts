import path from "node:path";
import { getProjectNames, getProjectSpec, type Project } from "./common";
import type { Schema } from "@railcar/inference";

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

async function analyze(project: Project): Promise<Row> {
    const spec = getProjectSpec(project);

    // No data if no bundle
    if (!spec.bundle) return { project };

    const schemaFile = `${RAILCAR_ROOT}/examples/${project}/typescript.json`;
    const schema: Schema = await Bun.file(schemaFile).json();

    const size = analyzeApiSize(schema);
    const higherOrderFunctions = analyzeHigherOrderFunctions(schema);

    const propertyAccesses = Math.floor(Math.random() * 1000);
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

async function main() {
    const csv = process.argv.includes("--csv");
    const projects = getProjectNames();
    const rows: Row[] = [];
    for (const project of projects) {
        rows.push(await analyze(project));
    }
    if (csv) {
        printCsv(rows);
    } else {
        console.table(rows);
    }
}

main();
