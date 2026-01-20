#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import yargs from "yargs";

import { deriveFromDeclFile } from "./derive.js";
import { syntestSchema } from "./syntest-infer.js";
import { loadSchema } from "./reflection.js";

import type { Schema, TypeGuess } from "./schema.js";

function absolute(path: string) {
    if (isAbsolute(path)) return path;
    return normalize(join(process.cwd(), path));
}

function validateTypeGuess(schema: Schema, guess: TypeGuess) {
    if (guess.kind.Object) {
        assert(guess.objectShape !== undefined);
        Object.values(guess.objectShape).forEach((g) =>
            validateTypeGuess(schema, g),
        );
    }

    if (guess.kind.Array) {
        assert(guess.arrayValueType !== undefined);
        validateTypeGuess(schema, guess.arrayValueType);
    }

    if (guess.kind.Class) {
        assert(guess.classType !== undefined);
        for (const key of Object.keys(guess.classType)) {
            assert(
                !!schema[key],
                `Class ${key} does not have a constructor in schema`,
            );
            assert(
                schema[key].callconv === "Constructor",
                `Class ${key} does not have a constructor in schema`,
            );
        }
    }
}

function validateSchema(schema: Schema) {
    // check if all types have backing endpoints
    for (const [name, type] of Object.entries(schema)) {
        assert(type !== null);
        type.args.forEach((g) => validateTypeGuess(schema, g));
        validateTypeGuess(schema, type.ret);

        if (type.callconv === "Method") {
            assert(type.args.length >= 1);
            assert(type.args[0].kind.Class === 1);
            const splits = name.split(".");
            const cls = splits.slice(0, -1).join(".");
            assert(
                type.args[0].classType?.[cls] === 1,
                `Inconsistent class receiver for method ${name}`,
            );
        } else if (type.callconv === "Constructor") {
            assert(type.ret.kind.Class === 1);
            assert(
                type.ret.classType?.[name] === 1,
                `Inconsistent return type for constructor ${name}`,
            );
        }
    }
}

async function getSkipMethods(configFile: string): Promise<string[]> {
    const config = await import(absolute(configFile));
    assert(config.skipMethods);
    assert(Array.isArray(config.skipMethods));
    if (config.skipMethods.length > 0) {
        assert(typeof config.skipMethods[0] === "string");
    }
    return config.skipMethods;
}

async function dispatch(args: Args): Promise<Schema> {
    if (args.syntest) {
        const file = absolute(args.syntest);
        return syntestSchema(file);
    }

    if (args.decl) {
        const file = absolute(args.decl);
        return deriveFromDeclFile(file);
    }

    if (args.dynamic) {
        const file = absolute(args.dynamic);
        const skip = args.config ? await getSkipMethods(args.config) : [];
        const { schema } = await loadSchema(file, undefined, skip);
        return schema;
    }

    throw Error("unreachable");
}

type Args = {
    syntest?: string;
    dynamic?: string;
    decl?: string;
    config?: string;
};

function parseArguments() {
    return (
        yargs(process.argv.slice(2))
            .scriptName("railcar-infer")

            // generic options
            .option("config", {
                type: "string",
                describe:
                    "Path to a Railcar configuration file. Useful to skip methods.",
            })
            .option("outFile", {
                alias: "o",
                type: "string",
                description: "File to write the inferred schema to",
            })

            // type inference modes
            .option("decl", {
                type: "string",
                describe: "Derive a schema from a TypeScript declaration file",
            })
            .option("syntest", {
                type: "string",
                describe:
                    "Derive a schema from a JavaScript file using SynTest's static type inference",
            })
            .option("dynamic", {
                type: "string",
                describe:
                    "Derive a schema from a JavaScript file purely using dynamic analysis",
            })

            // must use at most one type inference mode
            .conflicts("decl", ["syntest", "dynamic"])
            .conflicts("syntest", ["decl", "dynamic"])
            .conflicts("dynamic", ["syntest", "decl"])

            .parse()
    );
}

async function main() {
    const args = await parseArguments();

    // must use at least one type inference mode
    assert(
        args.syntest || args.decl || args.dynamic,
        "must specify a type inference mode, use --decl, --syntest or --dynamic",
    );

    const schema = await dispatch(args);
    validateSchema(schema);

    if (!args.outFile) {
        console.log(JSON.stringify(schema, null, 2));
    } else {
        await writeFile(
            absolute(args.outFile),
            JSON.stringify(schema, null, 2),
        );
    }
}

main();
