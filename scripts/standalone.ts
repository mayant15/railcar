/**
 * Runs all discovered Free endpoints with some inputs, based on the schema.
 */

import assert from "node:assert/strict"
import path from "node:path"

import {loadSchema, type TypeGuess, type Endpoints} from "@railcar/inference"
import {makeRailcarConfig} from "@railcar/support"
import {Chance} from "chance"

const NUM_INPUTS = 1000
const SEED = 1234
const MIN_INTEGER = 0
const MAX_INTEGER = 1000

async function importDefaultModule(path: string) {
    const mod = await import(path);
    return "default" in mod ? mod.default : mod;
}

async function loadConfig(path: string) {
    const config = await importDefaultModule(path)
    return makeRailcarConfig(config);
}

async function findEntryPoint(project: string) {
    // Needs TypeScript 5, not TypeScript 7
    if (project === "typescript") {
        return path.normalize(
            path.join(
                import.meta.dirname,
                "..", "examples", "node_modules", "typescript",
                "lib", "typescript.js",
            )
        )
    }

    let name = project
    switch (name) {
        case "turf": {
            name = "@turf/turf";
            break;
        }
        case "angular": {
            name = "@angular/compiler";
            break;
        }
        case "xmldom": {
            name = "@xmldom/xmldom";
            break;
        }
    }
    return new URL(import.meta.resolve(name)).pathname
}

function exampleDir(project: string) {
    return path.normalize(
        path.join(
            import.meta.dirname,
            "..",
            "examples",
            project
        )
    )
}

async function main() {
    const project = process.argv[2]
    assert(project !== undefined)

    const schemaKind = process.argv[3]
    assert(schemaKind !== undefined)

    const rand = new Chance(SEED)

    const examples = exampleDir(project)
    const entrypoint = await findEntryPoint(project)

    const config = await loadConfig(path.join(examples, "railcar.config.js"))

    const {schema, endpoints} = await loadSchema(entrypoint, {
        schemaFile: path.join(examples, `${schemaKind}.json`),
        methodsToSkip: config.skipMethods,
        skipEndpointsNotInSchema: true,
    })

    for (const [name, fn] of Object.entries(endpoints)) {
        if (!schema[name]) continue
        const sig = schema[name]

        if (sig.callconv !== "Free") continue

        console.log("running", name)
        let failed = 0
        for (let i = 0; i < NUM_INPUTS; ++i) {
            const args = sig.args.map(g => makeArg(rand, g, endpoints))
            try {
                await fn(...args)
            } catch (_) {
                failed += 1
            }
        }
        console.log("  failed", failed, "out of", NUM_INPUTS)
    }
}

const ANY: TypeGuess = {
    isAny: false,
    kind: {
        "String": 1/8,
        "Boolean": 1/8,
        "Number": 1/8,
        "Null": 1/8,
        "Undefined": 1/8,
        "Object": 1/8,
        "Array": 1/8,
        "Function": 1/8,
    },
    classType: { "Uint8Array": 1.0 },
    objectShape: {},
    arrayValueType: { isAny: true, kind: {} }
}

function makeArg(rand: Chance, guess: TypeGuess, endpoints: Endpoints): unknown {
    if (guess.isAny) return makeArg(rand, ANY, endpoints)

    const kinds = Object.keys(guess.kind)
    const kind = rand.pickone(kinds)

    switch (kind) {
        case "Null": return null
        case "Undefined": return undefined
        case "Function": return () => {}

        case "Boolean": return rand.bool()
        case "Number": return rand.integer({ min: MIN_INTEGER, max: MAX_INTEGER })
        case "String": return rand.string()

        case "Object": return makeObject(rand, guess, endpoints)

        // TODO: Should I fill this?
        case "Array": return []

        // TODO: Will have to generate arguments for the class constructor.
        // case "Class": return makeClass(rand, guess, endpoints)
    }
}

function makeObject(rand: Chance, guess: TypeGuess, endpoints: Endpoints) {
    assert(guess.kind.Object !== undefined)
    assert(guess.kind.Object > 0)
    assert(guess.objectShape !== undefined)

    return Object.fromEntries(
        Object.entries(guess.objectShape)
            .map(([name, g]) => [name, makeArg(rand, g, endpoints)])
    )
}

main()
