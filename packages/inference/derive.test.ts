// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, test, expect } from "bun:test"

import { tmpdir } from "node:os"
import { join } from "node:path"

import { fromFile } from "./derive.js"
import { type Schema } from "./schema.js"
import { Guess, Types } from "./common.js"

function fromCode(code: string): Schema {
    const tmpFile = join(tmpdir(), "railcar-derive-test.ts")
    Bun.write(tmpFile, code)
    return fromFile(tmpFile)
}

test("promise return type", () => {
    const code = `
export function sleep(ms: number): Promise<boolean>;
`
    const actual = fromCode(code)

    expect(actual["sleep"]).toEqual({
        args: [Guess.number()],
        ret:  Guess.exact(Types.class("Promise")),
        callconv: "Free",
    })
})

describe("functions", () => {
    test("simple", () => {
        const code = `
export function testString(x: string): string;
export function testNumber(x: number): number;
export function testBoolean(x: boolean): boolean;
export function testVoid(): void;
export function testNull(): null;
export function testUndefined(): undefined;
export function multipleParams(x: string, y: number, z: boolean): void;
`
        const actual = fromCode(code)

        expect(actual["testString"]).toEqual({
            args: [Guess.string()],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual["testNumber"]).toEqual({
            args: [Guess.number()],
            ret: Guess.number(),
            callconv: "Free",
        })

        expect(actual["testBoolean"]).toEqual({
            args: [Guess.boolean()],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["testVoid"]).toEqual({
            args: [],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["testNull"]).toEqual({
            args: [],
            ret: Guess.null(),
            callconv: "Free",
        })

        expect(actual["testUndefined"]).toEqual({
            args: [],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["multipleParams"]).toEqual({
            args: [Guess.string(), Guess.number(), Guess.boolean()],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("literal types", () => {
        const code = `
export function testStringLiteral(x: "hello"): "world";
export function testNumberLiteral(x: 42): 24;
export function testBooleanLiteral(x: true): false;
`
        const actual = fromCode(code)

        expect(actual["testStringLiteral"]).toEqual({
            args: [Guess.string()],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual["testNumberLiteral"]).toEqual({
            args: [Guess.number()],
            ret: Guess.number(),
            callconv: "Free",
        })

        expect(actual["testBooleanLiteral"]).toEqual({
            args: [Guess.boolean()],
            ret: Guess.boolean(),
            callconv: "Free",
        })
    })

    test("single optional parameter", () => {
        const code = `
export function single(y?: number);
`
        const actual = fromCode(code)

        expect(actual.single).toEqual({
            args: [Guess.optional(Types.number())],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("optional parameters", () => {
        const code = `
export function optionalSingle(x: string, y?: number): boolean;
export function optionalMultiple(x: number, y?: string, z?: boolean): void;
export function optionalAll(x?: string, y?: number, z?: boolean): string;
export function mixedOptional(x: string, y: number, z?: boolean, w?: string): { result: number };
`
        const actual = fromCode(code)
        const o = Guess.optional

        expect(actual["optionalSingle"]).toEqual({
            args: [Guess.string(), o(Types.number())],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["optionalMultiple"]).toEqual({
            args: [Guess.number(), o(Types.string()), o(Types.boolean())],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["optionalAll"]).toEqual({
            args: [o(Types.string()), o(Types.number()), o(Types.boolean())],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual["mixedOptional"]).toEqual({
            args: [Guess.string(), Guess.number(), o(Types.boolean()), o(Types.string())],
            ret: {
                isAny: false,
                kind: { Object: 1 },
                objectShape: { result: Guess.number() },
            },
            callconv: "Free",
        })
    })
})

describe("free functions", () => {
    test("simple", () => {
        const code = `
export function foo(): void;
`
        const actual = fromCode(code)

        expect(actual).toEqual({
            foo: {
                args: [],
                ret: Guess.undefined(),
                callconv: "Free"
            }
        })
    })

    test("overloads", () => {
        const code = `
export function foo(): void;
export function foo(x: number): number;
`
        const actual = fromCode(code)

        expect(actual).toEqual({
            foo: {
                args: [],
                ret: Guess.undefined(),
                callconv: "Free"
            }
        })
    })
})

describe("union types", () => {
    test("simple unions", () => {
        const code = `
export function stringOrNumber(x: string | number): boolean;
export function booleanOrString(x: boolean | string): void;
export function numberOrBoolean(x: number | boolean): string | number;
`
        const actual = fromCode(code)

        expect(actual["stringOrNumber"]).toEqual({
            args: [Guess.union(Guess.string(), Guess.number())],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["booleanOrString"]).toEqual({
            args: [{
                isAny: false,
                kind: { String: 0.3333333333333333, Boolean: 0.6666666666666666 },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["numberOrBoolean"]).toEqual({
            args: [{
                isAny: false,
                kind: { Number: 0.3333333333333333, Boolean: 0.6666666666666666 },
            }],
            ret: Guess.union(Guess.string(), Guess.number()),
            callconv: "Free",
        })
    })

    test("mixed literal unions", () => {
        const code = `
export function mixedLiterals(x: string | "hello" | 42 | true): void;
export function literalUnion(x: "a" | "b" | "c"): "x" | "y" | "z";
export function numberLiteralUnion(x: 1 | 2 | 3): 4 | 5 | 6;
`
        const actual = fromCode(code)

        expect(actual["mixedLiterals"]).toEqual({
            args: [{
                isAny: false,
                kind: { String: 0.3333333333333333, Number: 0.3333333333333333, Boolean: 0.3333333333333333 },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["literalUnion"]).toEqual({
            args: [Guess.string()],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual["numberLiteralUnion"]).toEqual({
            args: [Guess.number()],
            ret: Guess.number(),
            callconv: "Free",
        })
    })

    test("complex unions", () => {
        const code = `
export function complexUnion(x: Array<string> | { a: number } | (() => void)): void;
export function objectUnion(x: { a: string } | { b: number }): { c: boolean };
export function arrayUnion(x: string[] | number[]): boolean[];
`
        const actual = fromCode(code)

        expect(actual["complexUnion"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 0.3333333333333333, Array: 0.3333333333333333, Function: 0.3333333333333333 },
                arrayValueType: Guess.string(),
                objectShape: { a: Guess.any() },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["objectUnion"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { a: Guess.any(), b: Guess.any() },
            }],
            ret: {
                isAny: false,
                kind: { Object: 1 },
                objectShape: { c: Guess.any() },
            },
            callconv: "Free",
        })

        expect(actual["arrayUnion"]).toEqual({
            args: [{
                isAny: false,
                kind: { Array: 1 },
                arrayValueType: Guess.union(Guess.string(), Guess.number()),
            }],
            ret: Guess.array(Guess.boolean()),
            callconv: "Free",
        })
    })
})

describe("arrays", () => {
    test("simple arrays", () => {
        const code = `
export function stringArray(x: string[]): number[];
export function numberArray(x: Array<number>): boolean;
export function booleanArray(x: boolean[]): void;
`
        const actual = fromCode(code)

        expect(actual["stringArray"]).toEqual({
            args: [Guess.array(Guess.string())],
            ret: Guess.array(Guess.number()),
            callconv: "Free",
        })

        expect(actual["numberArray"]).toEqual({
            args: [Guess.array(Guess.number())],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["booleanArray"]).toEqual({
            args: [Guess.array(Guess.boolean())],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("complex arrays", () => {
        const code = `
export function objectArray(x: Array<{ a: string; b: number }>): void;
export function functionArray(x: (() => void)[]): boolean;
export function nestedArray(x: Array<string[]>): number[][];
export function unionElementArray(x: Array<string | number>): boolean;
`
        const actual = fromCode(code)

        expect(actual["objectArray"]).toEqual({
            args: [{
                isAny: false,
                kind: { Array: 1 },
                arrayValueType: {
                    isAny: false,
                    kind: { Object: 1 },
                    objectShape: { a: Guess.any(), b: Guess.any() },
                },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["functionArray"]).toEqual({
            args: [Guess.array(Guess.func())],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["nestedArray"]).toEqual({
            args: [Guess.array(Guess.array(Guess.string()))],
            ret: Guess.array(Guess.array(Guess.number())),
            callconv: "Free",
        })

        expect(actual["unionElementArray"]).toEqual({
            args: [{
                isAny: false,
                kind: { Array: 1 },
                arrayValueType: Guess.union(Guess.string(), Guess.number()),
            }],
            ret: Guess.boolean(),
            callconv: "Free",
        })
    })

    test("tuple types", () => {
        const code = `
export function simpleTuple(x: [string, number, boolean]): void;
export function objectTuple(x: [string, { a: number }]): boolean;
export function mixedTuple(x: [string, number, { a: boolean }]): [string, boolean];
`
        const actual = fromCode(code)

        expect(actual["simpleTuple"]).toBeDefined()
        expect(actual["objectTuple"]).toBeDefined()
        expect(actual["mixedTuple"]).toBeDefined()
    })
})

describe("objects", () => {
    test("simple objects", () => {
        const code = `
export function simpleObject(x: { a: string; b: number }): void;
export function userObject(x: { name: string; age: number }): { id: string };
export function configObject(x: { debug: boolean; port: number }): void;
`
        const actual = fromCode(code)

        expect(actual["simpleObject"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { a: Guess.any(), b: Guess.any() },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["userObject"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { name: Guess.any(), age: Guess.any() },
            }],
            ret: {
                isAny: false,
                kind: { Object: 1 },
                objectShape: { id: Guess.any() },
            },
            callconv: "Free",
        })

        expect(actual["configObject"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { debug: Guess.any(), port: Guess.any() },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("optional properties", () => {
        const code = `
export function optionalObject(x: { a?: string; b: number }): void;
export function allOptional(x: { name?: string; age?: number }): boolean;
export function mixedOptional(x: { required: string; optional?: number }): { result?: boolean };
`
        const actual = fromCode(code)

        expect(actual["optionalObject"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { a: Guess.any(), b: Guess.any() },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["allOptional"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { name: Guess.any(), age: Guess.any() },
            }],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["mixedOptional"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { required: Guess.any(), optional: Guess.any() },
            }],
            ret: {
                isAny: false,
                kind: { Object: 1 },
                objectShape: { result: Guess.any() },
            },
            callconv: "Free",
        })
    })

    test("nested objects", () => {
        const code = `
export function nestedObject(x: { a: { b: string; c: number } }): void;
export function deepNested(x: { user: { profile: { name: string; age: number } } }): boolean;
export function arrayNested(x: { items: { id: string; value: number }[] }): { results: { success: boolean }[] };
`
        const actual = fromCode(code)

        expect(actual["nestedObject"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { a: Guess.any() },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["deepNested"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { user: Guess.any() },
            }],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["arrayNested"]).toEqual({
            args: [{
                isAny: false,
                kind: { Object: 1 },
                objectShape: { items: Guess.any() },
            }],
            ret: {
                isAny: false,
                kind: { Object: 1 },
                objectShape: { results: Guess.any() },
            },
            callconv: "Free",
        })
    })
})

describe("function overloading", () => {
    test("basic overloading", () => {
        const code = `
export function overloaded(x: number): string;
export function overloaded(x: number, y: string): boolean;
export function noParams(): void;
export function noParams(x: string): number;
`
        const actual = fromCode(code)

        expect(actual["overloaded"]).toEqual({
            args: [Guess.number()],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual["noParams"]).toEqual({
            args: [],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("complex overloading", () => {
        const code = `
export function complexOverload(x: string): number;
export function complexOverload(x: number): string;
export function complexOverload(x: string, y?: boolean): void;
export function complexOverload(x: { a: string }): { b: number };
`
        const actual = fromCode(code)

        expect(actual["complexOverload"]).toBeDefined()
    })
})

describe("classes", () => {
    test("simple class", () => {
        const code = `
export class A {}
`
        const actual = fromCode(code)

        expect(actual).toEqual({
            A: {
                args: [],
                ret: Guess.exact({ Class: "A" }),
                callconv: "Constructor",
            }
        })
    })

    test("simple class with constructor", () => {
        const code = `
export class A {
    constructor();
}
`
        const actual = fromCode(code)

        expect(actual).toEqual({
            A: {
                args: [],
                ret: Guess.exact({ Class: "A" }),
                callconv: "Constructor",
            }
        })
    })

    test("simple constructor", () => {
        const code = `
export class SimpleClass {
    constructor();
}
`
        const actual = fromCode(code)

        expect(actual["SimpleClass"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "SimpleClass" }),
            callconv: "Constructor",
        })
    })

    test("no explicit constructor", () => {
        const code = `
export class NoConstructorClass {
    method(): string;
    static staticMethod(): number;
}
`
        const actual = fromCode(code)

        expect(actual["NoConstructorClass"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "NoConstructorClass" }),
            callconv: "Constructor",
        })

        expect(actual["NoConstructorClass.method"]).toEqual({
            args: [],
            ret: Guess.string(),
            callconv: "Method",
        })
    })

    test("constructor overload", () => {
        const code = `
export class SimpleClass {
    constructor();
    constructor(value: string)
}
`
        const actual = fromCode(code)

        expect(actual["SimpleClass"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "SimpleClass" }),
            callconv: "Constructor",
        })
    })

    test("methods", () => {
        const code = `
export class MethodClass {
    constructor();
    simpleMethod(): string;
    methodWithParams(x: number, y: boolean): void;
    methodReturningObject(): { a: string; b: number };
}
`
        const actual = fromCode(code)

        expect(actual["MethodClass"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "MethodClass" }),
            callconv: "Constructor",
        })

        expect(actual["MethodClass.simpleMethod"]).toEqual({
            args: [],
            ret: Guess.string(),
            callconv: "Method",
        })

        expect(actual["MethodClass.methodWithParams"]).toEqual({
            args: [Guess.number(), Guess.boolean()],
            ret: Guess.undefined(),
            callconv: "Method",
        })

        expect(actual["MethodClass.methodReturningObject"]).toEqual({
            args: [],
            ret: {
                isAny: false,
                kind: { Object: 1 },
                objectShape: { a: Guess.any(), b: Guess.any() },
            },
            callconv: "Method",
        })
    })

    test("inheritance", () => {
        const code = `
export class Base {
    constructor();
    base(x: number): void;
}

export class Derived extends Base {
    constructor();
    derived(): void;
}
`
        const actual = fromCode(code)

        expect(actual["Base"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "Base" }),
            callconv: "Constructor",
        })

        expect(actual["Base.base"]).toEqual({
            args: [Guess.number()],
            ret: Guess.undefined(),
            callconv: "Method",
        })

        expect(actual["Derived"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "Derived" }),
            callconv: "Constructor",
        })

        expect(actual["Derived.base"]).toEqual({
            args: [Guess.number()],
            ret: Guess.undefined(),
            callconv: "Method",
        })

        expect(actual["Derived.derived"]).toEqual({
            args: [],
            ret: Guess.undefined(),
            callconv: "Method",
        })
    })

    test("static methods", () => {
        const code = `
export class StaticClass {
    constructor();
    static staticMethod(): string;
    static staticWithParams(x: number): boolean;
    instanceMethod(): void;
}
`
        const actual = fromCode(code)

        expect(actual["StaticClass"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "StaticClass" }),
            callconv: "Constructor",
        })

        expect(actual["StaticClass.instanceMethod"]).toEqual({
            args: [],
            ret: Guess.undefined(),
            callconv: "Method",
        })
    })
})

describe("interfaces", () => {
    test("inheritance", () => {
        const code = `
interface BaseNode {
    visit(): any;
}
export class Node implements BaseNode {
    constructor();
}
`
        const actual = fromCode(code)

        expect(actual["Node"]).toEqual({
            args: [],
            ret: Guess.exact({ Class: "Node" }),
            callconv: "Constructor"
        })
    })
})
