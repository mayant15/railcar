import assert from "node:assert";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Schema, SignatureGuess } from "@railcar/inference";

import { getProjectNames } from "./common";

const LATEX = false;

async function schema(project: string, kind: string): Promise<Schema> {
    const path = join("examples", project, `${kind}.json`);
    return JSON.parse((await readFile(path)).toString());
}

function allAny(sig: SignatureGuess): boolean {
    switch (sig.callconv) {
        case "Free": {
            // ret and all args must be any
            return sig.ret.isAny && sig.args.every((arg) => arg.isAny);
        }
        case "Constructor": {
            // all args must be any
            return sig.args.every((arg) => arg.isAny);
        }
        case "Method": {
            // ret and all args[1..] must be any
            return sig.ret.isAny && sig.args.slice(1).every((arg) => arg.isAny);
        }
    }
}

function countNoInfoSignatures(schema: Schema): [number, number] {
    let total = 0;
    let any = 0;
    for (const [_, guess] of Object.entries(schema)) {
        if (guess.builtin) continue;
        total += 1;
        if (allAny(guess)) {
            // console.warn(" ", name);
            any += 1;
        }
    }
    return [total, any];
}

function countAny(schema: Schema): [number, number] {
    let total = 0;
    let any = 0;
    for (const guess of Object.values(schema)) {
        const types = [guess.ret, ...guess.args];
        total += types.length;

        const anyTypes = types.filter((t) => t.isAny);
        any += anyTypes.length;
    }

    assert(any <= total);
    return [total, any];
}

type AnalyzeRow = {
    project: string;
    random: {
        total: number;
        any: number;
        anyTypeP: number;
    };
    typescript: {
        any: number;
        anyTypeP: number;
    };
    syntest: {
        any: number;
        anyTypeP: number;
    };
};

async function analyze(project: string) {
    const p1 = await schema(project, "random");
    // const p2 = schema(project, "syntest");
    const p3 = schema(project, "typescript");
    const [random, typescript] = await Promise.all([p1, p3]);

    const [totalRandom, anyRandom] = countNoInfoSignatures(random);
    const [_totalSyntest, anySyntest] = [1, 0]; // countNoInfoSignatures(syntest);

    // console.warn("typescript");
    const [totalTypescript, anyTypescript] = countNoInfoSignatures(typescript);

    // assert(totalRandom === totalSyntest);
    assert(totalRandom === totalTypescript);
    assert(totalRandom === anyRandom);
    // assert(totalRandom >= anySyntest);
    assert(totalRandom >= anyTypescript);

    const [totalRandomTypes, anyRandomTypes] = countAny(random);
    const [totalSyntestTypes, anySyntestTypes] = [1, 0]; //countAny(syntest);
    const [totalTypescriptTypes, anyTypescriptTypes] = countAny(typescript);

    return {
        project,
        random: {
            total: totalRandom,
            any: anyRandom,
            anyTypeP: (anyRandomTypes * 100) / totalRandomTypes,
        },
        typescript: {
            any: anyTypescript,
            anyTypeP: (anyTypescriptTypes * 100) / totalTypescriptTypes,
        },
        syntest: {
            any: anySyntest,
            anyTypeP: (anySyntestTypes * 100) / totalSyntestTypes,
        },
    };
}

function printLatex(data: AnalyzeRow[]) {
    console.log("\\begin{tabular}{lrrrrrrr}");
    console.log("\\toprule");
    console.log(
        "  \\multirow{2}{*}{\\textbf{Benchmark}} & \\multirow{2}{*}{\\textbf{Total}} & \\multicolumn{2}{c}{\\textbf{Random}} & \\multicolumn{2}{c}{\\textbf{Inferred}} & \\multicolumn{2}{c}{\\textbf{Annotated}} \\\\",
    );
    console.log(
        "  & & \\textbf{\\# APIs} & \\textbf{\\% Any} & \\textbf{\\# APIs} & \\textbf{\\% Any} & \\textbf{\\# APIs} & \\textbf{\\% Any} \\\\",
    );
    console.log("\\midrule");

    for (const row of data) {
        const { project, random, typescript, syntest } = row;
        console.log(
            "  %s & %d & %d & %f & %d & %f & %d & %f \\\\",
            project,
            random.total,
            random.any,
            random.anyTypeP.toFixed(1),
            syntest.any,
            syntest.anyTypeP.toFixed(1),
            typescript.any,
            typescript.anyTypeP.toFixed(1),
        );
    }

    console.log("\\bottomrule");
    console.log("\\end{tabular}");
}

function printTable(data: AnalyzeRow[]) {
    console.table(
        data.map((d) => ({
            Benchmark: d.project,
            Total: d.random.total,
            "Random # Any API": d.random.any,
            "Random % Any Types": d.random.anyTypeP.toFixed(1),
            "TypeScript # Any API": d.typescript.any,
            "TypeScript % Any Types": d.typescript.anyTypeP.toFixed(1),
            // "SynTest # Any API": d.syntest.any,
            // "SynTest % Any Types": d.syntest.anyTypeP.toFixed(1),
        })),
    );
}

async function main() {
    const data: AnalyzeRow[] = [];
    const projects = getProjectNames();
    for (const project of projects) {
        data.push(await analyze(project));
    }
    if (LATEX) {
        printLatex(data);
    } else {
        printTable(data);
    }
}

main();
