/**
 * Decode and pretty-print a Railcar corpus entry.
 *
 * Usage:
 *   bun scripts/dump-corpus-entry.ts <path-to-corpus-file-or-dir> [more...]
 *
 * Each argument can be a corpus file or a directory; directories are
 * recursively walked one level deep (sufficient for `corpus/`).
 *
 * A corpus entry is a msgpack-encoded `ApiSeq` (from packages/fuzzer/src/seq.rs).
 *
 * The on-disk schema (see ApiSeq::to_file, written with rmp_serde::to_vec_named):
 *
 *   ApiSeq      = { fuzz: bytes, seq: ApiCall[] }
 *   ApiCall     = { id: string, name: string, args: ApiCallArg[], conv: CallConvention }
 *   ApiCallArg  = "Missing" | { Output: string } | { Constant: Type }
 *   Type        = "Number" | "String" | "Boolean" | "Undefined" | "Null" | "Function"
 *                 | { Object: {[k: string]: Type} }
 *                 | { Class: string }
 *                 | { Array: Type }
 *   CallConv    = "Free" | "Method" | "Constructor"
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e6154-0e11-7618-a785-f362df2a3358
 */

import { decode } from "@msgpack/msgpack";
import fs from "node:fs";

type CallConvention = "Free" | "Method" | "Constructor";

type Type =
    | "Number"
    | "String"
    | "Boolean"
    | "Undefined"
    | "Null"
    | "Function"
    | { Object: Record<string, Type> }
    | { Class: string }
    | { Array: Type };

type ApiCallArg = "Missing" | { Output: string } | { Constant: Type };

interface ApiCall {
    id: string;
    name: string;
    args: ApiCallArg[];
    conv: CallConvention;
}

interface ApiSeq {
    fuzz: Uint8Array;
    seq: ApiCall[];
}

function fmtType(t: Type): string {
    if (typeof t === "string") return t;
    if ("Object" in t) {
        const entries = Object.entries(t.Object).map(
            ([k, v]) => `${k}: ${fmtType(v)}`,
        );
        return `{${entries.join(", ")}}`;
    }
    if ("Class" in t) return `Class(${t.Class})`;
    if ("Array" in t) return `Array<${fmtType(t.Array)}>`;
    return JSON.stringify(t);
}

function fmtArg(arg: ApiCallArg, shortId: (id: string) => string): string {
    if (arg === "Missing") return "<missing>";
    if ("Output" in arg) return `$${shortId(arg.Output)}`;
    if ("Constant" in arg) return fmtType(arg.Constant);
    return JSON.stringify(arg);
}

function dumpFile(file: string) {
    let bytes: Buffer;
    try {
        bytes = fs.readFileSync(file);
    } catch (e) {
        console.error(`# error reading ${file}: ${(e as Error).message}`);
        return;
    }

    let seq: ApiSeq;
    try {
        seq = decode(bytes) as ApiSeq;
    } catch (e) {
        console.error(`# error decoding ${file}: ${(e as Error).message}`);
        return;
    }

    const idIndex = new Map<string, number>();
    seq.seq.forEach((c, i) => {
        idIndex.set(c.id, i);
    });
    const shortId = (id: string): string => {
        const i = idIndex.get(id);
        return i !== undefined ? String(i) : id.slice(0, 8);
    };

    process.stdout.write(`# file: ${file}\n`);
    process.stdout.write(`# fuzz bytes: ${seq.fuzz?.length ?? 0}\n`);
    process.stdout.write(`# calls: ${seq.seq.length}\n`);

    const lines: string[] = [];
    seq.seq.forEach((call, i) => {
        const args = call.args.map((a) => fmtArg(a, shortId)).join(", ");
        const tag =
            call.conv === "Constructor"
                ? "new "
                : call.conv === "Method"
                  ? "method "
                  : "";
        lines.push(`$${i} = ${tag}${call.name}(${args})`);
    });
    process.stdout.write(`${lines.join("\n")}\n\n`);
}

function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error(
            "usage: bun scripts/dump-corpus-entry.ts <file-or-dir> [more...]",
        );
        process.exit(1);
    }

    for (const arg of args) {
        const stat = fs.statSync(arg);
        if (stat.isDirectory()) {
            const entries = fs.readdirSync(arg).sort();
            for (const e of entries) {
                // libafl writes `.<id>` lock files and `.<id>_N.metadata`
                // alongside each corpus entry; skip those.
                if (e.startsWith(".")) continue;
                const p = `${arg}/${e}`;
                if (fs.statSync(p).isFile()) dumpFile(p);
            }
        } else {
            dumpFile(arg);
        }
    }
}

main();
