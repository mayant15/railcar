// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import { transformSync } from "@babel/core";
import { decode, encode } from "@msgpack/msgpack";
import { hookRequire } from "istanbul-lib-hook";

import type { Schema, Graph } from "@railcar/inference";
import { makeRailcarConfig } from "@railcar/support";

import { CoverageMap } from "@railcar/worker-sys";

import type { ExitKind } from "./common";
import { codeCoverage } from "./instrument";
import { BytesExecutor } from "./bytes";
import { GraphExecutor } from "./graph";
import { Console } from "node:console";
import fs from "node:fs/promises";

declare global {
    var __railcar__: {
        recordHit: (edgeId: number) => void;
    };
}

type Mode = "bytes" | "parametric" | "graph";

type ShMemDescription = {
    size: number;
    id: {
        id: number[];
    };
};

type InitArgs = {
    mode: Mode;
    entrypoint: string;
    schemaFile: string | null;
    coverage: ShMemDescription | null;
    replay: boolean;
    configFile: string;
};

type Message =
    | { Init: InitArgs }
    | { InitOk: Schema | null }
    | { Invoke: { bytes: Uint8Array } }
    | { InvokeOk: ExitKind }
    | { Log: string }
    | "Terminate";

let _executor: BytesExecutor | GraphExecutor | null = null;
let _coverage: CoverageMap | null = null;

async function exists(path: string) {
    try {
        await fs.access(path, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

async function importDefaultModule(path: string) {
    const mod = await import(path);
    return "default" in mod ? mod.default : mod;
}

async function loadConfigFile(configFile: string) {
    const _exists = await exists(configFile);
    const config = _exists ? await importDefaultModule(configFile) : {};
    return makeRailcarConfig(config);
}

async function init(args: InitArgs): Promise<Schema | null> {
    const config = await loadConfigFile(args.configFile);

    if (!args.replay) {
        assert(
            args.coverage !== null,
            "fuzzer must provide a shmem coverage map if not replay",
        );
        _coverage = new CoverageMap(args.coverage);

        setupHooks(config.instrumentFilter);
    }

    if (args.mode === "bytes") {
        _executor = new BytesExecutor();
        await _executor.init(args.entrypoint, config.oracle, args.replay);
        return null;
    } else {
        // both parametric and graph should use the same executor
        _executor = new GraphExecutor();

        const schema = await _executor.init(
            args.entrypoint,
            config.oracle,
            args.schemaFile ?? undefined,
            args.replay,
            config.methodsToSkip,
        );
        return schema;
    }
}

async function invoke(bytes: Uint8Array): Promise<ExitKind> {
    assert(_executor !== null);
    if (_executor instanceof BytesExecutor) {
        return _executor.execute(bytes);
    } else {
        const graph = decode(bytes) as Graph;
        return _executor.execute(graph);
    }
}

async function handleMessage(msg: Message) {
    if (msg === "Terminate") {
        process.exit();
    }

    if ("Init" in msg) {
        const args = msg.Init;
        const schema = await init(args);
        send({
            InitOk: schema,
        });
        return;
    }

    if ("Invoke" in msg) {
        const kind = await invoke(msg.Invoke.bytes);
        send({
            InvokeOk: kind,
        });
        return;
    }
}

function send(msg: Message) {
    const bytes = encode(msg);
    process.stdout.write(bytes);
}

function concat(a: Buffer, b: Buffer): Buffer {
    // no alloc fast path
    if (a.length === 0) return b;
    if (b.length === 0) return a;

    // allocate a new buffer
    const big = new Uint8Array(a.length + b.length);
    for (let i = 0; i < a.length; ++i) {
        big[i] = a[i];
    }
    for (let i = 0; i < b.length; ++i) {
        big[i + a.length] = b[i];
    }
    return Buffer.from(big);
}

// NOTE: nodejs streams have a limit to how large the buffer can be for `process.stdin.on('data')`.
// Need to buffer the message here and read it in parts.
// See `highWaterMark` https://nodejs.org/api/stream.html
let _recvBuf: Buffer = Buffer.from([]);
function recv(data: Buffer): Message | null {
    try {
        _recvBuf = concat(_recvBuf, data);
        const msg = decode(_recvBuf) as Message;
        _recvBuf = Buffer.from([]);
        return msg;
    } catch (e) {
        // incomplete message
        if (e instanceof RangeError) {
            return null;
        }
        throw e;
    }
}

function setupHooks(filter: (_: string) => boolean) {
    global.__railcar__ = {
        recordHit(edge: number) {
            _coverage!.recordHit(edge);
        },
    };

    const plugins = [codeCoverage()];
    hookRequire(filter, (code, { filename }) => {
        const codeResult = transformSync(code, {
            filename,
            sourceFileName: filename,
            sourceMaps: true,
            plugins,
        });

        assert(codeResult !== null);
        assert(codeResult.code !== null);
        assert(codeResult.code !== undefined);
        assert(codeResult.map !== null);
        assert(codeResult.map !== undefined);

        return codeResult.code;
    });
}

// Write all logs to stderr instead of stdout. The Rust parent process reads for
// msgpack messages on stdout.
global.console = new Console(process.stderr, process.stderr);

process.stdin.on("data", (buf) => {
    const msg = recv(buf);
    if (msg === null) {
        // buffer is incomplete, wait for remaining bytes
        return;
    }
    handleMessage(msg);
});
