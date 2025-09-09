// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";
import { Duplex } from "node:stream";
import { readFileSync } from "node:fs";

import type {
    EndpointName,
    Endpoints,
    Fn,
    Schema,
    SignatureGuess,
} from "./schema";
import { Guess } from "./common";
import { MAX_OBJECT_MAPPING_DEPTH } from "./config";

function removeInvalidEndpoints(schema: Schema, endpoints: Endpoints): Schema {
    return Object.fromEntries(
        Object.entries(schema).filter(([name]) => {
            if (!endpoints[name]) {
                console.warn(
                    `[railcar-infer] Missing endpoint for ${name}. Skipping.`,
                );
                return false;
            }
            if (typeof endpoints[name] !== "function") {
                console.warn(
                    `[railcar-infer] Invalid endpoint for ${name}. Skipping.`,
                );
                return false;
            }

            return true;
        }),
    );
}

let _countFnNotInSchema = 0;

function mapStandardReferences(
    schema: Schema,
    endpoints: Endpoints,
    methodsToSkip: Set<EndpointName>,
) {
    // Do not map methods for builtin classes, we're more interested in fuzzing the library
    function builtin(cls: unknown, argc?: number) {
        mapFunctionReference(
            "",
            schema,
            endpoints,
            cls as Fn,
            methodsToSkip,
            (cls as Fn).name,
            argc,
            true,
        );
    }

    builtin(Uint8Array, 0);
    builtin(ArrayBuffer, 1);
    builtin(RegExp, 0);
    builtin(SharedArrayBuffer, 1);
    builtin(Error, 1);
    builtin(Duplex);

    // new Buffer is deprecated. Node prefers Buffer.alloc() or Buffer.from()
    mapFunctionReference(
        "",
        schema,
        endpoints,
        Buffer.from as Fn,
        methodsToSkip,
        "Buffer",
        1,
        true,
    );
}

const BUILTIN_METHODS = new Set([
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "valueOf",
    "toLocaleString",
]);

function getMethods(constr: { prototype: unknown }) {
    const methods: [string, Fn][] = [];

    let current = constr.prototype;
    while (typeof current === "object" && current !== null) {
        // NOTE: Use descriptors instead of direct names. protobuf-js defines some properties with
        // descriptors to attach getters to them that crash when inspecting the prototype without a
        // class instance
        const descs = Object.getOwnPropertyDescriptors(current);
        for (const [prop, desc] of Object.entries(descs)) {
            if (
                !BUILTIN_METHODS.has(prop) &&
                desc.value &&
                typeof desc.value === "function" &&
                !prop.startsWith("_") // skip private methods
            ) {
                methods.push([prop, desc.value]);
            }
        }
        current = Object.getPrototypeOf(current);
    }

    return methods;
}

function getStatics(constr: object) {
    const statics: [string, Fn][] = [];

    for (const [name, fn] of Object.entries(constr)) {
        if (typeof fn !== "function") {
            continue;
        }

        if (BUILTIN_METHODS.has(name)) {
            continue;
        }

        statics.push([name, fn]);
    }

    return statics;
}

function isConstructor(fn: Fn): boolean {
    // try calling without new
    try {
        const maybePromise = fn();
        if (maybePromise instanceof Promise) {
            maybePromise.catch(() => {});
        }
    } catch (err) {
        if (err instanceof TypeError) {
            // NOTE: Node v22.12.0 throws this error when calling Uint8Array without `new`. This is
            // not standard (Bun also throws an error but with a different message).
            if (err.message.includes("requires 'new'")) {
                return true;
            }

            // classes defined with the `class` keyword throw this in Node.js
            if (err.message.includes("cannot be invoked without 'new'")) {
                return true;
            }

            // classes defined with the `class` keyword throw this in Bun
            if (
                err.message.includes(
                    "cannot call a class constructor without |new|",
                )
            ) {
                return true;
            }
        }
    }

    // try calling with new
    try {
        // @ts-ignore
        const maybePromise = new fn();
        if (maybePromise instanceof Promise) {
            maybePromise.catch(() => {});
        }
    } catch (err) {
        if (err instanceof TypeError) {
            if (err.message.includes("is not a constructor")) {
                return false;
            }
        }
    }

    // check if it has a prototype
    if (!("prototype" in fn)) {
        return false;
    }

    // check if it has user-defined methods
    const methods = Object.entries(
        Object.getOwnPropertyDescriptors(fn.prototype),
    ).filter(([prop, desc]) => {
        return (
            !BUILTIN_METHODS.has(prop) &&
            desc.value &&
            typeof desc.value === "function"
        );
    });

    if (methods.length !== 0) {
        return true;
    }

    // check if it adds to `this`
    const _this = {};
    try {
        const maybePromise = fn.apply(_this);
        if (maybePromise instanceof Promise) {
            maybePromise.catch(() => {});
        }
    } catch (err) {}

    if (Object.keys(_this).length > 0) {
        return true;
    }

    return false;
}

function addToSchema(schema: Schema, id: EndpointName, sig: SignatureGuess) {
    _countFnNotInSchema += 1;
    schema[id] = sig;
}

function mapFunctionReference(
    prefix: string,
    schema: Schema,
    endpoints: Endpoints,
    fn: Fn,
    methodsToSkip: Set<EndpointName>,
    overrideKey?: string,
    overrideArgc?: number,
    builtin?: boolean,
) {
    const key = prefix + (overrideKey ?? fn.name);
    if (methodsToSkip.has(key)) {
        return;
    }

    const isConstr =
        schema[key]?.callconv === "Constructor" || isConstructor(fn);

    endpoints[key] = fn;

    if (!schema[key]) {
        addToSchema(schema, key, {
            callconv: isConstr ? "Constructor" : "Free",
            ret: isConstr ? Guess.class(key) : Guess.any(),
            args: new Array(overrideArgc ?? fn.length).fill(Guess.any()),
            builtin,
        });
    }

    if (isConstr && !builtin) {
        const methods = getMethods(fn);
        for (const [methodName, method] of methods) {
            const id = `${key}.${methodName}`;
            if (methodsToSkip.has(id)) {
                continue;
            }

            endpoints[id] = method;
            if (schema[id]) {
                assert(schema[id].callconv === "Method");
            } else {
                const args = new Array(method.length).fill(Guess.any());
                addToSchema(schema, id, {
                    callconv: "Method",
                    ret: Guess.any(),
                    args: [Guess.class(key), ...args],
                    builtin,
                });
            }
        }

        const statics = getStatics(fn);
        for (const [staticName, staticFn] of statics) {
            const id = `${key}.${staticName}`;
            if (methodsToSkip.has(id)) {
                continue;
            }

            endpoints[id] = staticFn;
            if (schema[id]) {
                if (schema[id].callconv === "Method") {
                    // This is a collision. A static method shares its name with a method.
                    // Keep the method
                } else {
                    assert(schema[id].callconv === "Free", id);
                    assert(schema[id].builtin === builtin);
                }
            } else {
                const args = new Array(staticFn.length).fill(Guess.any());
                addToSchema(schema, id, {
                    callconv: "Free",
                    ret: Guess.any(),
                    args,
                    builtin,
                });
            }
        }
    }
}

function mapFunctionsOnObject(
    depth: number,
    prefix: string,
    schema: Schema,
    endpoints: Endpoints,
    obj: object,
    methodsToSkip: Set<EndpointName>,
) {
    if (depth >= MAX_OBJECT_MAPPING_DEPTH) {
        return;
    }

    const entries = Object.entries(obj);
    for (const [key, value] of entries) {
        if (typeof value === "function") {
            mapFunctionReference(
                prefix,
                schema,
                endpoints,
                value,
                methodsToSkip,
                key,
            );
        } else {
            if (typeof value === "object" && value !== null) {
                mapFunctionsOnObject(
                    depth + 1,
                    `${prefix}${key}.`,
                    schema,
                    endpoints,
                    value,
                    methodsToSkip,
                );
            }
        }
    }
}

function mapExportedReferences(
    schema: Schema,
    endpoints: Endpoints,
    main: Fn | Record<string, unknown>,
    methodsToSkip: Set<EndpointName>,
) {
    // NOTE: We assume a default exported function is a constructor (mainly for the Sharp benchmark)
    if (
        typeof main === "function" ||
        (typeof main === "object" &&
            "default" in main &&
            typeof main.default === "function")
    ) {
        const fn: Fn = typeof main === "function" ? main : (main.default as Fn);
        mapFunctionReference("", schema, endpoints, fn, methodsToSkip);
    }

    const exports =
        typeof main === "object" && "default" in main
            ? (main.default as Record<string, unknown>)
            : main;

    mapFunctionsOnObject(0, "", schema, endpoints, exports, methodsToSkip);
}

export async function loadSchema(
    mainModule: string,
    schemaFile?: string,
    methodsToSkip?: EndpointName[],
): Promise<{ schema: Schema; endpoints: Endpoints }> {
    const main = await import(mainModule);

    const schema: Schema = schemaFile
        ? JSON.parse(readFileSync(schemaFile).toString())
        : {};
    const endpoints: Endpoints = {};

    const toSkip = new Set(methodsToSkip ?? []);
    mapStandardReferences(schema, endpoints, toSkip);
    mapExportedReferences(schema, endpoints, main, toSkip);

    removeInvalidEndpoints(schema, endpoints);

    console.warn(
        `[railcar-infer] Found ${_countFnNotInSchema} endpoints that were not in schema.`,
    );

    return {
        schema,
        endpoints,
    };
}
