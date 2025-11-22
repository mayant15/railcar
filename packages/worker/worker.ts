// SPDX-License-Identifier: AGPL-3.0-or-later

import assert, { AssertionError } from "node:assert";
import fs from "node:fs/promises";
import { Console } from "node:console";
import { registerHooks } from "node:module";

import { transformSync } from "@babel/core";
import { decode, encode } from "@msgpack/msgpack";

import type { Schema, Graph } from "@railcar/inference";
import { makeRailcarConfig } from "@railcar/support";
import { SharedExecutionData } from "@railcar/worker-sys";

import type { ExitKind } from "./common.ts";
import { codeCoverage } from "./instrument.js";
import { BytesExecutor } from "./bytes.js";
import { GraphExecutor } from "./graph.js";
import { ENABLE_DEBUG_INFO } from "./config.js";
import { type ApiSeq, SequenceExecutor } from "./sequence.js";

declare global {
    var __railcar__: {
        recordHit: (edgeId: number) => void;
    };
}

type Mode = "bytes" | "parametric" | "graph" | "sequence";

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
    shmem: ShMemDescription | null;
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

let _executor: BytesExecutor | GraphExecutor | SequenceExecutor | null = null;
let _shmem: SharedExecutionData | null = null;

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
            args.shmem !== null,
            "fuzzer must provide a shmem coverage map if not replay",
        );
        _shmem = new SharedExecutionData(args.shmem);

        setupHooks(config.instrumentFilter);
    }

    if (args.mode === "bytes") {
        _executor = new BytesExecutor(_shmem);
        await _executor.init(args.entrypoint, config.oracle, args.replay);
        return null;
    } else if (args.mode === "graph" || args.mode === "parametric") {
        // both parametric and graph should use the same executor
        _executor = new GraphExecutor(_shmem);

        const schema = await _executor.init(
            args.entrypoint,
            config.oracle,
            args.schemaFile ?? undefined,
            args.replay,
            config.methodsToSkip,
        );
        return schema;
    } else if (args.mode === "sequence") {
        _executor = new SequenceExecutor(_shmem);
        const schema = await _executor.init(
            args.entrypoint,
            config.oracle,
            args.schemaFile ?? undefined,
            args.replay,
            config.methodsToSkip,
        );
        return schema;
    } else {
        throw new AssertionError({ message: "unreachable" });
    }
}

async function invoke(bytes: Uint8Array): Promise<ExitKind> {
    assert(_executor !== null);
    if (_executor instanceof BytesExecutor) {
        return _executor.execute(bytes);
    } else if (_executor instanceof GraphExecutor) {
        return _executor.execute(decode(bytes) as Graph);
    } else {
        return _executor.execute(decode(bytes) as ApiSeq);
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

// See https://nodejs.org/docs/latest-v24.x/api/module.html#loadurl-context-nextload
function shouldIntercept(
    url: string,
    format: string,
    customFilter: (_: string) => boolean,
): boolean {
    if (format.startsWith("commonjs") || format.startsWith("module")) {
        return customFilter(url);
    }
    return false;
}

function setupHooks(filter: (_: string) => boolean) {
    const [getNumEdges, plugin] = codeCoverage();

    global.__railcar__ = {
        recordHit(edge: number) {
            _shmem!.recordHit(edge, getNumEdges());
        },
    };

    const plugins = [plugin];

    registerHooks({
        load(url, context, nextLoad) {
            const _default = nextLoad(url, context);

            if (!_default.format) {
                if (ENABLE_DEBUG_INFO) {
                    console.warn("missing format info for", url);
                }
                return _default;
            }

            if (!shouldIntercept(url, _default.format, filter)) {
                if (ENABLE_DEBUG_INFO) {
                    console.warn("skipping", url);
                }
                return _default;
            }

            if (_default.source === undefined) {
                console.warn("missing source for", url);
                return _default;
            }

            const code = _default.source.toString();

            const transformed = transformSync(code, {
                filename: url,
                sourceFileName: url,
                sourceMaps: true,
                plugins,
            });

            console.log(`RAILCAR inserted ${getNumEdges()} coverage edge(s)`);

            assert(transformed !== null);
            assert(transformed.code !== null);
            assert(transformed.code !== undefined);
            assert(transformed.map !== null);
            assert(transformed.map !== undefined);

            return {
                format: _default.format,
                shortCircuit: true,
                source: transformed.code,
            };
        },
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
