import assert from "node:assert"

import {readFile} from "node:fs/promises"
import {join} from "node:path"

import type {Schema, SignatureGuess} from "@railcar/inference"

const PROJECTS = [
    "fast-xml-parser",
    "tslib",
    "pako",
    "sharp",
    "redux",
    "jimp",
    "jpeg-js",
    "js-yaml",
]

async function schema(project: string, kind: string): Promise<Schema> {
    const path = join("examples", project, `${kind}.json`)
    return JSON.parse((await readFile(path)).toString())
}

function allAny(sig: SignatureGuess): boolean {
    switch (sig.callconv) {
        case "Free": {
            // ret and all args must be any
            return sig.ret.isAny && sig.args.every(arg => arg.isAny)
        }
        case "Constructor": {
            // all args must be any
            return sig.args.every(arg => arg.isAny)
        }
        case "Method": {
            // ret and all args[1..] must be any
            return sig.ret.isAny && sig.args.slice(1).every(arg => arg.isAny)
        }
    }
}

function countAnyGuesses(schema: Schema): [number, number] {
    let total = 0
    let any = 0
    for (const [name, guess] of Object.entries(schema)) {
        if (guess.builtin) continue;
        total += 1
        if (allAny(guess)) {
            any += 1
        }
    }
    return [total, any]
}

async function analyze(project: string) {
    const p1 = await schema(project, "random")
    const p2 = schema(project, "syntest")
    const p3 = schema(project, "typescript")
    const [random, syntest, typescript] = await Promise.all([p1, p2, p3])

    const [totalRandom, anyRandom] = countAnyGuesses(random)
    const [totalSyntest, anySyntest] = countAnyGuesses(syntest)
    const [totalTypescript, anyTypescript] = countAnyGuesses(typescript)

    assert(totalRandom === totalSyntest)
    assert(totalRandom === totalTypescript)
    assert(totalRandom === anyRandom)
    assert(totalRandom >= anySyntest)
    assert(totalRandom >= anyTypescript)

    console.log("  %s & %d & %d & %d & %d \\\\", project, totalRandom, anyRandom, anySyntest, anyTypescript)
}

async function main() {

    console.log("\\begin{tabular}{lrrrr}")
    console.log("\\toprule")
    console.log("  Benchmark & Total & Random & Inferred & Annotated \\\\")
    console.log("\\midrule")

    for (const project of PROJECTS) {
        await analyze(project)
    }

    console.log("\\bottomrule")
    console.log("\\end{tabular}")
}

main()
