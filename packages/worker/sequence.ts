import assert, { AssertionError } from "node:assert";

import {
    loadSchema,
    type EndpointName,
    type Schema,
    type Endpoints,
    type Type,
    type CallConvention,
} from "@railcar/inference";
import type { SharedExecutionData } from "@railcar/worker-sys";

import { ExitKind, withOracle } from "./common.js";
import { FuzzedDataProvider, type Oracle } from "@railcar/support";
import {
    ENABLE_DEBUG_INFO,
    MAX_ARRAY_LENGTH,
    STRING_MAX_LENGTH,
} from "./config.js";

export type ApiSeq = {
    fuzz: Uint8Array;
    seq: ApiCall[];
};

export type ApiCall = {
    name: EndpointName;
    args: ApiCallArg[];
    conv: CallConvention;
};

export type ApiCallArg = { Constant: Type } | { Output: number } | "Missing";

export class SequenceExecutor {
    _executor: (seq: ApiSeq) => Promise<ExitKind> = (_) =>
        Promise.resolve(ExitKind.Ok);
    _shmem: SharedExecutionData | null = null;
    _num_executed: number = 0;

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
            (seq) => this.interpret(endpoints, seq),
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

    async execute(sequence: ApiSeq): Promise<ExitKind> {
        this._num_executed = 0;
        const result = await this._executor(sequence);
        this._shmem?.setNumCallsExecuted(this._num_executed);
        return result;
    }

    async interpret(endpoints: Endpoints, { fuzz, seq }: ApiSeq) {
        const ctx = {
            fdp: new FuzzedDataProvider(fuzz),
            endpoints,
            objects: new Array(seq.length).fill(null),
        };

        for (let i = 0; i < seq.length; ++i) {
            const call = seq[i];
            const args = call.args.map((arg) => getArg(ctx, arg));
            const result = await invokeEndpoint(ctx, call, args);
            this._num_executed += 1;
            ctx.objects[i] = result;
        }
    }
}

type Context = {
    endpoints: Endpoints;
    fdp: FuzzedDataProvider;
    objects: unknown[];
};

interface UnknownConstructor {
    new (...args: unknown[]): unknown;
}

function invokeEndpoint(
    ctx: Context,
    call: ApiCall,
    args: unknown[],
): Promise<unknown> {
    const fn = ctx.endpoints[call.name];
    switch (call.conv) {
        case "Method": {
            assert(args.length >= 1, "methods must receive atleast 1 argument");
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

function getArg(ctx: Context, spec: ApiCallArg): unknown {
    assert(spec !== "Missing");

    if ("Output" in spec) {
        return ctx.objects[spec.Output];
    }

    assert("Constant" in spec);
    return constant(ctx.fdp, spec.Constant);
}

function constant(fdp: FuzzedDataProvider, type: Type): unknown {
    switch (type) {
        case "Number":
            return fdp.consumeNumber();
        case "String":
            return fdp.consumeString(STRING_MAX_LENGTH, "utf8", true);
        case "Boolean":
            return fdp.consumeBoolean();
        case "Undefined":
            return undefined;
        case "Null":
            return null;
        case "Function":
            return () => {};
        default: {
        }
    }

    assert(typeof type === "object");
    assert(!("Class" in type)); // if we want a class, add the constructor to seq instead

    if ("Object" in type) {
        return Object.fromEntries(
            Object.entries(type.Object).map(([key, ty]) => [
                key,
                constant(fdp, ty),
            ]),
        );
    }

    if ("Array" in type) {
        const length = fdp.consumeNumberInRange(0, MAX_ARRAY_LENGTH);
        const array = new Array(length);
        for (let i = 0; i < length; ++i) {
            array[i] = constant(fdp, type.Array);
        }
        return array;
    }

    throw new AssertionError({ message: "unreachable" });
}
