/**
 * Check generated schemas in the repository.
 *
 * Enforces the following properties for each project:
 * 1. All three schemas must have the same set of keys.
 * 2. All three schemas must have the standard library.
 */

import { describe, test, expect } from "bun:test";

import { Guess, type TypeGuess, type Schema } from "@railcar/inference";

import { type Project, getProjectNames } from "./common";

type SchemaKind = "random" | "typescript";

async function readSchemaFile(
    project: Project,
    kind: SchemaKind,
): Promise<Schema> {
    const path = `../examples/${project}/${kind}.json`;
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

for (const project of getProjectNames()) {
    describe(project, async () => {
        const schemas = await fetchSchemas(project);

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

        describe("must have the standard library", () => {
            for (const kind of ["random", "typescript"] as const) {
                test(kind, () => {
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
            }
        });
    });
}

function expectClass(schema: Schema, name: string, args: TypeGuess[]) {
    expect(schema[name]).toEqual({
        args,
        ret: Guess.class(name),
        callconv: "Constructor",
        builtin: true,
    });
}
