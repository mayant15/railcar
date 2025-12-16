// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import {
    loadSchema,
    type Graph,
    type Endpoints,
    type Schema,
    type Node,
    type NodeId,
    type ConstantValue,
    type EndpointName,
} from "@railcar/inference";
import type { Oracle } from "@railcar/support";
import type { SharedExecutionData } from "@railcar/worker-sys";

import { withOracle } from "./common.js";
import { ENABLE_DEBUG_INFO, ENABLE_HEAVY_ASSERTIONS } from "./config.js";

export class GraphExecutor {
    _executor: (graph: Graph) => Promise<boolean> = (_) =>
        Promise.resolve(true);
    _shmem: SharedExecutionData | null = null;

    constructor(shmem: SharedExecutionData | null) {
        this._shmem = shmem;
    }

    async init(
        mainModule: string,
        oracle: Oracle,
        schemaFile?: string,
        logError?: boolean,
        methodsToSkip?: EndpointName[],
    ): Promise<Schema> {
        const { schema, endpoints } = await loadSchema(
            mainModule,
            schemaFile,
            methodsToSkip,
        );

        this._executor = withOracle(
            (graph) => interpret(endpoints, graph),
            oracle,
            logError,
            this._shmem,
        );

        if (ENABLE_DEBUG_INFO) {
            console.log("=== SCHEMA ===");
            console.table(schema);
        }

        return schema;
    }

    async execute(graph: Graph): Promise<boolean> {
        if (ENABLE_DEBUG_INFO) {
            console.log(
                JSON.stringify(
                    graph,
                    (key, value) => {
                        if (key === "context" || key === "schema") {
                            return undefined;
                        } else {
                            return value;
                        }
                    },
                    2,
                ),
            );
        }

        if (ENABLE_HEAVY_ASSERTIONS) {
            validateGraph(graph);
        }

        return this._executor(graph);
    }
}

function validateNode(node: Node) {
    if ("Api" in node.payload) {
        const argc = node.payload.Api.signature.args.length;
        assert(node.incoming.length === argc);

        const ports = node.incoming.map((inc) => inc.port);
        const set = new Set(ports);
        assert(set.size === ports.length, "duplicate ports");

        for (let i = 0; i < argc; ++i) {
            assert(set.has(i), `port ${i} unfilled`);
        }
    } else {
        assert(node.incoming.length === 0, "constant node has incoming edges");
    }
}

function validateGraph(graph: Graph) {
    for (const node of Object.values(graph.nodes)) {
        validateNode(node);
    }
    assert(graph.root in graph.nodes);
}

type InterpreterContext = Record<NodeId, unknown>;

function visited(ctx: InterpreterContext, node: Node): boolean {
    return node.id in ctx;
}

async function interpret(endpoints: Endpoints, graph: Graph) {
    const terminals = Object.values(graph.nodes).filter(
        (node) => node.outgoing.length === 0,
    );
    assert(terminals.length >= 1);

    const ctx: InterpreterContext = {};

    for (const terminal of terminals) {
        await interpretNode(ctx, terminal, graph, endpoints);
    }

    // debug validation
    if (ENABLE_HEAVY_ASSERTIONS) {
        let size = 0;
        for (const node of Object.values(graph.nodes)) {
            assert(visited(ctx, node));
            size++;
        }
        assert(Object.keys(ctx).length === size);
    }
}

interface UnknownConstructor {
    new (...args: unknown[]): unknown;
}

function invokeEndpoint(
    node: Node,
    args: unknown[],
    endpoints: Endpoints,
): Promise<unknown> {
    if ("Api" in node.payload) {
        const fn = endpoints[node.payload.Api.name];
        const cc = node.payload.Api.signature.callconv;
        switch (cc) {
            case "Method": {
                assert(
                    args.length >= 1,
                    "methods must receive atleast 1 argument",
                );
                const [thisArg, ...rest] = args;
                return Promise.resolve(fn.apply(thisArg, rest)); // invoke this method with a class object as `this`
            }
            case "Constructor": {
                const Constr = fn as unknown as UnknownConstructor;
                return Promise.resolve(new Constr(...args));
            }
            default:
                return Promise.resolve(fn(...args));
        }
    }

    return Promise.resolve(constantValue(node.payload.Constant.value));
}

function constantValue(cv: ConstantValue): unknown {
    if (cv === "Undefined") {
        return undefined;
    }

    if (cv === "Null") {
        return null;
    }

    if (cv === "Function") {
        // callbacks are all noops
        return () => void 0;
    }

    if ("String" in cv) {
        return cv.String;
    }

    if ("Boolean" in cv) {
        return cv.Boolean;
    }

    if ("Number" in cv) {
        return cv.Number;
    }

    if ("Object" in cv) {
        return Object.fromEntries(
            Object.entries(cv.Object).map(([name, prop]) => [
                name,
                constantValue(prop),
            ]),
        );
    }

    if ("Array" in cv) {
        return cv.Array.map(constantValue);
    }

    return null;
}

async function interpretNode(
    ctx: InterpreterContext,
    node: Node,
    graph: Graph,
    endpoints: Endpoints,
): Promise<unknown> {
    // return precomputed value if exists
    if (visited(ctx, node)) {
        return ctx[node.id];
    }

    const entries = [];
    const sorted = node.incoming.toSorted((a, b) => {
        return a.evaluationOrder < b.evaluationOrder
            ? -1
            : a.evaluationOrder > b.evaluationOrder
              ? 1
              : 0;
    });
    for (const inc of sorted) {
        entries.push([
            inc.evaluationOrder,
            await interpretNode(ctx, graph.nodes[inc.src], graph, endpoints),
        ]);
    }
    const argumentsInEvalOrder: Record<number, unknown> =
        Object.fromEntries(entries);

    const args = node.incoming.map(
        (inc) => argumentsInEvalOrder[inc.evaluationOrder],
    );

    const returned = await invokeEndpoint(node, args, endpoints);

    ctx[node.id] = returned;

    return returned;
}
