#!/usr/bin/env node

// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import yargs from "yargs";

import { deriveFromDeclFile } from "./derive.js";
import tsSchema from "./typescript.js";
import type { Schema, TypeGuess } from "./schema.js";
import { syntestSchema } from "./syntest-infer.js";

export const PROJECTS = [
    "fast-xml-parser",
    "pako",
    "js-yaml",
    "protobuf-js",
    "sharp",
    "example",
] as const;

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

async function main() {
    const args = yargs(process.argv.slice(2))
        .scriptName("railcar-infer")
        .option("hardcoded", {
            type: "string",
            choices: PROJECTS,
            describe:
                "Return a hardcoded schema for one of the example projects",
        })
        .option("decl", {
            type: "string",
            describe: "Derive a schema from a TypeScript declaration file",
        })
        .option("syntest", {
            type: "string",
            describe: "Derive a schema from a js file",
        })
        .option("full", {
            alias: "f",
            type: "boolean",
            describe: "Enable full mode",
        })
        .implies("full", "syntest")
        .option("outFile", {
            alias: "o",
            type: "string",
            description: "File to write the inferred schema to",
        })
        .parseSync();

    assert(
        args.syntest || args.hardcoded || args.decl || args.syntestPlus,
        "must either give a project name for hardcoded schemas or a declaration file, or use Syntest",
    );
    const schema = !args.syntest
        ? (() => {
              if (args.hardcoded) {
                  return tsSchema[args.hardcoded];
              }

              assert(args.decl);
              return deriveFromDeclFile(absolute(args.decl));
          })()
        : await syntestSchema(absolute(args.syntest), args.full);

    validateSchema(schema);

    if (!args.outFile) {
        console.log(JSON.stringify(schema, null, 2));
    } else {
        writeFileSync(absolute(args.outFile), JSON.stringify(schema, null, 2));
    }
}

main();
