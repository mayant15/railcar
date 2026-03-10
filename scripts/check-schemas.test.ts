/**
 * Check generated schemas in the repository.
 *
 * Enforces the following properties for each project:
 * 1. All three schemas must have the same set of keys.
 * 2. All three schemas must have the standard library.
 * 3. All NoInfo signature guesses must be known.
 * 4. All schemas are idempotent. Running the schema through the fuzzer doesn't change it.
 */

import { $ } from "bun";
import { describe, test, expect } from "bun:test";
import path from "node:path";
import assert from "node:assert";

import { Guess, type TypeGuess, type Schema } from "@railcar/inference";

import {
    type Project,
    getProjectNames,
    getProjectSpec,
    isNoInfoSignature,
    findEntryPoint,
} from "./common";

type SchemaKind = "random" | "typescript";

switchToRailcarRootDir();

for (const project of getProjectNames()) {
    describe(project, async () => {
        const schemas = await fetchSchemas(project);
        const spec = getProjectSpec(project);

        test("all three schemas must have the same set of endpoints", () => {
            const keys = {
                random: Object.keys(schemas.random).sort(),
                typescript: Object.keys(schemas.typescript).sort(),
            };

            expect(keys.random.length).toBe(keys.typescript.length);
            for (let i = 0; i < keys.random.length; ++i) {
                expect(keys.random[i]).toBe(keys.typescript[i]);
            }
        });

        test("typescript schema must only have known no info guesses", () => {
            for (const [name, guess] of Object.entries(schemas.typescript)) {
                if (isNoInfoSignature(guess)) {
                    const known = spec.known ?? [];
                    expect(name).toBeOneOf(known);
                }
            }
        });

        for (const kind of ["random", "typescript"] as const) {
            describe(kind, () => {
                test("must have standard library", () => {
                    const schema = schemas[kind];
                    expectClass(schema, "Uint8Array", []);
                    expectClass(schema, "ArrayBuffer", [Guess.number()]);
                    expectClass(schema, "RegExp", []);
                    expectClass(schema, "SharedArrayBuffer", [Guess.number()]);
                    expectClass(schema, "Error", [Guess.optional("String")]);
                    expectClass(schema, "Duplex", []);

                    expect(schema["Buffer.from"]).toEqual({
                        args: [Guess.string()],
                        ret: Guess.class("Buffer"),
                        callconv: "Free",
                        builtin: true,
                    });
                });
            });

            test("must be idempotent", async () => {
                const entrypoint = await findEntryPoint(project);
                const schema = schemaPath(project, kind);
                const is = await isIdempotent(project, entrypoint, schema);
                expect(is).toBeTrue();
            });
        }
    });
}

function switchToRailcarRootDir() {
    const cwd = process.cwd();
    assert(path.basename(cwd) === "scripts");
    const root = path.dirname(cwd);
    process.chdir(root);
}

function schemaPath(project: Project, kind: SchemaKind): string {
    return `examples/${project}/${kind}.json`;
}

async function readSchemaFile(
    project: Project,
    kind: SchemaKind,
): Promise<Schema> {
    const path = schemaPath(project, kind);
    const file = Bun.file(path);
    return file.json();
}

async function fetchSchemas(
    project: Project,
): Promise<Record<SchemaKind, Schema>> {
    return {
        random: await readSchemaFile(project, "random"),
        typescript: await readSchemaFile(project, "typescript"),
    };
}

function expectClass(schema: Schema, name: string, args: TypeGuess[]) {
    expect(schema[name]).toEqual({
        args,
        ret: Guess.class(name),
        callconv: "Constructor",
        builtin: true,
    });
}

async function isIdempotent(
    project: string,
    entrypoint: string,
    schema: string,
): Promise<boolean> {
    const config = `examples/${project}/railcar.config.js`;

    Bun.spawnSync({
        cmd: [
            "cargo",
            "run",
            "--bin",
            "railcar",
            "--release",
            "--",
            "--config",
            config,
            "--mode",
            "sequence",
            "--schema",
            schema,
            "--iterations",
            "0",
            "--debug-dump-schema",
            "schema.json",
            entrypoint,
        ],
        stdout: "ignore",
        stderr: "ignore",
    });

    const diff = await $`diff ${schema} schema.json`.quiet();
    return diff.exitCode === 0;
}
