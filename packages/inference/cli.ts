#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";
import { writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import yargs from "yargs";

import { deriveFromDeclFile } from "./derive.js";
import { syntestSchema } from "./syntest-infer.js";
import { loadSchemaFromObject } from "./reflection.js";

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
    const mod = await import(absolute(configFile));
    const skip = mod.default.skipMethods;

    if (skip) {
        assert(Array.isArray(skip));
        if (skip.length > 0) {
            assert(typeof skip[0] === "string");
        }
        return skip;
    }

    return [];
}

async function dispatch(args: Args): Promise<Schema> {
    const entrypoint = absolute(args.entrypoint);

    let schema = {};

    if (args.syntest) {
        schema = syntestSchema(entrypoint);
    }

    if (args.decl) {
        const types = absolute(args.decl);
        schema = deriveFromDeclFile(types);
    }

    const skip = args.config ? await getSkipMethods(args.config) : [];

    const loaded = await loadSchemaFromObject(entrypoint, schema, skip);

    return loaded.schema;
}

type Args = {
    entrypoint: string;
    syntest?: boolean;
    dynamic?: boolean;
    decl?: string;
    config?: string;
};

async function parseArguments() {
    const cmd = yargs(process.argv.slice(2))
        .scriptName("railcar-infer")

        // generic options
        .option("entrypoint", {
            type: "string",
            describe: "Path to a JS module you want the schema for",
            demandOption: true,
        })
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
            type: "boolean",
            describe: "Derive a schema using SynTest's static type inference",
        })
        .option("dynamic", {
            type: "boolean",
            describe: "Derive a schema purely using dynamic type inference",
        })

        // must use at most one type inference mode
        .conflicts("decl", ["syntest", "dynamic"])
        .conflicts("syntest", ["decl", "dynamic"])
        .conflicts("dynamic", ["syntest", "decl"]);

    const args = await cmd.parse();

    if (!args.syntest && !args.decl && !args.dynamic) {
        cmd.showHelp();
        console.error();
        console.error(
            "Must specify a type inference mode, use --decl, --syntest or --dynamic",
        );
        process.exit(1);
    }

    return args;
}

async function main() {
    const args = await parseArguments();

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
