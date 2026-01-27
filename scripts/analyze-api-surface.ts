import assert from "node:assert";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Schema, SignatureGuess } from "@railcar/inference";

import { getProjectNames } from "./common";

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
    for (const guess of Object.values(schema)) {
        if (guess.builtin) continue;
        total += 1;
        if (allAny(guess)) {
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

async function analyze(project: string) {
    const p1 = await schema(project, "random");
    const p2 = schema(project, "syntest");
    const p3 = schema(project, "typescript");
    const [random, syntest, typescript] = await Promise.all([p1, p2, p3]);

    const [totalRandom, anyRandom] = countNoInfoSignatures(random);
    const [totalSyntest, anySyntest] = countNoInfoSignatures(syntest);
    const [totalTypescript, anyTypescript] = countNoInfoSignatures(typescript);

    assert(totalRandom === totalSyntest);
    assert(totalRandom === totalTypescript);
    assert(totalRandom === anyRandom);
    assert(totalRandom >= anySyntest);
    assert(totalRandom >= anyTypescript);

    const [totalRandomTypes, anyRandomTypes] = countAny(random);
    const [totalSyntestTypes, anySyntestTypes] = countAny(syntest);
    const [totalTypescriptTypes, anyTypescriptTypes] = countAny(typescript);

    console.log(
        "  %s & %d & %d & %f & %d & %f & %d & %f \\\\",
        project,
        totalRandom,
        anyRandom,
        ((anyRandomTypes * 100) / totalRandomTypes).toFixed(1),
        anySyntest,
        ((anySyntestTypes * 100) / totalSyntestTypes).toFixed(1),
        anyTypescript,
        ((anyTypescriptTypes * 100) / totalTypescriptTypes).toFixed(1),
    );
}

async function main() {
    console.log("\\begin{tabular}{lrrrrrrr}");
    console.log("\\toprule");
    console.log(
        "  \\multirow{2}{*}{\\textbf{Benchmark}} & \\multirow{2}{*}{\\textbf{Total}} & \\multicolumn{2}{c}{\\textbf{Random}} & \\multicolumn{2}{c}{\\textbf{Inferred}} & \\multicolumn{2}{c}{\\textbf{Annotated}} \\\\",
    );
    console.log(
        "  & & \\textbf{\\# APIs} & \\textbf{\\% Any} & \\textbf{\\# APIs} & \\textbf{\\% Any} & \\textbf{\\# APIs} & \\textbf{\\% Any} \\\\",
    );
    console.log("\\midrule");

    const projects = getProjectNames();
    for (const project of projects) {
        await analyze(project);
    }

    console.log("\\bottomrule");
    console.log("\\end{tabular}");
}

main();
