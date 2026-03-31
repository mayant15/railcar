/**
 * Check generated schemas in the repository.
 *
 * Enforces the following properties for each project:
 * 1. All three schemas must have the same set of keys.
 * 2. All three schemas must have the standard library.
 * 3. All three schemas must have the same `builtin` flag for the same endpoints.
 * 4. All NoInfo signature guesses must be known.
 * 5. All schemas are idempotent. Running the schema through the fuzzer doesn't change it.
 * 6. All probability distributions must sum to 1.
 * 7. All endpoints should have the same calling convention.
 */

import { $ } from "bun";
import { describe, test, expect } from "bun:test";
import path from "node:path";
import assert from "node:assert";

import {
    Guess,
    type TypeGuess,
    type Schema,
    type Distribution,
} from "@railcar/inference";

import {
    type Project,
    type SchemaKind,
    getProjectNames,
    getProjectSpec,
    isNoInfoSignature,
    findEntryPoint,
} from "../common";


switchToRailcarRootDir();

for (const project of getProjectNames()) {
    describe(project, async () => {
        const schemas = await fetchSchemas(project);
        const spec = getProjectSpec(project);

        test("all three schemas must have the same set of endpoints", () => {
            const keys = {
                random: Object.keys(schemas.random).sort(),
                typescript: Object.keys(schemas.typescript).sort(),
                syntest: Object.keys(schemas.syntest).sort(),
            };

            expect(keys.random).toEqual(keys.typescript);
            expect(keys.syntest).toEqual(keys.typescript);
        });

        test("all endpoints must have the same callconv", () => {
            const keys = Object.keys(schemas.typescript);
            for (const key of keys) {
                const expected = schemas.typescript[key].callconv;

                // A little trick to make failed test reports a bit nicer, report the key as well.
                expect([key, schemas.random[key].callconv]).toEqual([
                    key,
                    expected,
                ]);
                expect([key, schemas.syntest[key].callconv]).toEqual([
                    key,
                    expected,
                ]);
            }
        });

        test("all endpoints must have the same builtin flag", () => {
            const keys = Object.keys(schemas.typescript);
            for (const key of keys) {
                const expected = schemas.typescript[key].builtin;

                // A little trick to make failed test reports a bit nicer, report the key as well.
                expect([key, schemas.random[key].builtin]).toEqual([
                    key,
                    expected,
                ]);
                expect([key, schemas.syntest[key].builtin]).toEqual([
                    key,
                    expected,
                ]);
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

        test.todo(
            "syntest schema must only have known no info guesses",
            () => {},
        );

        for (const kind of ["random", "typescript", "syntest"] as const) {
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

                test("must be idempotent", async () => {
                    const entrypoint = await findEntryPoint(project);
                    const schema = schemaPath(project, kind);
                    const is = await isIdempotent(project, entrypoint, schema);
                    expect(is).toBeTrue();
                });

                test("all probability distributions must sum to 1", () => {
                    const schema = schemas[kind];
                    for (const { ret, args } of Object.values(schema)) {
                        expectCompleteGuess(ret);
                        for (const arg of args) {
                            expectCompleteGuess(arg);
                        }
                    }
                });
            });
        }
    });
}

function expectCompleteGuess(guess: TypeGuess) {
    if (guess.isAny) return;

    expectSumTo1(guess.kind);

    if (guess.kind.Array) {
        expect(guess.arrayValueType).toBeDefined();
        expectCompleteGuess(guess.arrayValueType!);
    }

    if (guess.kind.Class) {
        expect(guess.classType).toBeDefined();
        expectSumTo1(guess.classType!);
    }

    if (guess.kind.Object) {
        expect(guess.objectShape).toBeDefined();
        for (const prop of Object.values(guess.objectShape!)) {
            expectCompleteGuess(prop);
        }
    }
}

function expectSumTo1<T extends string | number>(dist: Distribution<T>) {
    const ps: number[] = Object.values(dist);
    const sum = ps.reduce((acc, p) => acc + p, 0);
    expect(sum).toBeCloseTo(1);
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
        syntest: await readSchemaFile(project, "syntest"),
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
