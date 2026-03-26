import { getProjectNames, getProjectSpec, type Project } from "./common";

type Row = {
    project: Project;
    propertyAccesses?: number;
    inputValidationComplexity?: number;
    higherOrderFunctions?: number;
    inputUsageComplexity?: number;
};

async function analyze(project: Project): Promise<Row> {
    const spec = getProjectSpec(project);

    // No data if no bundle
    if (!spec.bundle) return { project };

    const propertyAccesses = Math.floor(Math.random() * 1000);
    const inputValidationComplexity = Math.floor(Math.random() * 1000);
    const higherOrderFunctions = Math.floor(Math.random() * 1000);
    const inputUsageComplexity = Math.floor(Math.random() * 1000);
    return {
        project,
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
