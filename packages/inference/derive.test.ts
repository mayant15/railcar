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

describe("function signatures", () => {
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

    test("assume any if no return type", () => {
        const code = `
export function foo();
`
        const actual = fromCode(code)

        expect(actual.foo).toEqual({
            args: [],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("literal types", () => {
        const code = `
export function testStringLiteral(x: "hello"): "world";
export function testNumberLiteral(x: 42): 24;
export function testBooleanLiteral(x: true): false;
export function nullLiteral(x: null);
export function undefinedLiteral(x: undefined);
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

        expect(actual["nullLiteral"]).toEqual({
            args: [Guess.null()],
            ret: Guess.any(),
            callconv: "Free"
        })

        expect(actual["undefinedLiteral"]).toEqual({
            args: [Guess.undefined()],
            ret: Guess.any(),
            callconv: "Free"
        })
    })

    test("single optional parameter", () => {
        const code = `
export function single(y?: number);
`
        const actual = fromCode(code)

        expect(actual.single).toEqual({
            args: [Guess.optional(Types.number())],
            ret: Guess.any(),
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

    test("unwrap promise return type", () => {
        const code = `
export function sleep(ms: number): Promise<boolean>;
`
        const actual = fromCode(code)

        expect(actual["sleep"]).toEqual({
            args: [Guess.number()],
            ret: Guess.boolean(),
            callconv: "Free",
        })
    })

    test("interfaces with call signatures", () => {
        const code = `
interface Foo {
    (...args: unknown[]): any;
}
export function foo(x: Foo);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.func()],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("records are objects", () => {
        const code = `
export function foo(x: Record<string, unknown>);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.object({})],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("symbols are any", () => {
        const code = `
export function foo(x: Symbol);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.any()],
            ret: Guess.any(),
            callconv: "Free",
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
            args: [Guess.union(Guess.boolean(), Guess.string())],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["numberOrBoolean"]).toEqual({
            args: [Guess.union(Guess.number(), Guess.boolean())],
            ret: Guess.union(Guess.string(), Guess.number()),
            callconv: "Free",
        })
    })

    test("mixed literal unions", () => {
        const code = `
export function literalUnion(x: "a" | "b" | "c"): "x" | "y" | "z";
export function numberLiteralUnion(x: 1 | 2 | 3): 4 | 5 | 6;
export function mixedLiterals(x: string | 42 | true): void;
`
        const actual = fromCode(code)

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

        expect(actual["mixedLiterals"]).toEqual({
            args: [{
                isAny: false,
                kind: { String: 0.333, Number: 0.333, Boolean: 0.333 },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("handles collapsing", () => {
        const code = `
export function stringUnion(x: string | "hello");
export function numberUnion(x: number | 42);
export function boolUnion(x: boolean | true);
export function mixedUnion(x: string | "hello" | number);
`
        const actual = fromCode(code)

        expect(actual.stringUnion).toEqual({
            args: [Guess.string()],
            ret: Guess.any(),
            callconv: "Free"
        })

        expect(actual.numberUnion).toEqual({
            args: [Guess.number()],
            ret: Guess.any(),
            callconv: "Free"
        })

        expect(actual.boolUnion).toEqual({
            args: [Guess.boolean()],
            ret: Guess.any(),
            callconv: "Free"
        })

        expect(actual.mixedUnion).toEqual({
            args: [Guess.union(Guess.string(), Guess.number())],
            ret: Guess.any(),
            callconv: "Free"
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
                kind: { Object: 0.333, Array: 0.333, Function: 0.333 },
                arrayValueType: Guess.string(),
                objectShape: { a: Guess.number() },
            }],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["objectUnion"]).toEqual({
            args: [
                Guess.object({
                    a: Guess.optional(Types.string()),
                    b: Guess.optional(Types.number()),
                })
            ],
            ret: Guess.object({ c: Guess.boolean() }),
            callconv: "Free",
        })

        expect(actual["arrayUnion"]).toEqual({
            args: [
                Guess.array(Guess.union(Guess.string(), Guess.number())),
            ],
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
            args: [
                Guess.array(Guess.object({
                    a: Guess.string(),
                    b: Guess.number(),
                }))
            ],
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
            args: [
                Guess.array(Guess.union(Guess.string(), Guess.number()))
            ],
            ret: Guess.boolean(),
            callconv: "Free",
        })
    })

    test("simple primitive tuple", () => {
        const code = `
export function tuple(x: [string, number, boolean]);
`
        const actual = fromCode(code)

        expect(actual.tuple).toEqual({
            args: [
                Guess.array(
                    Guess.union(Guess.string(), Guess.number(), Guess.boolean())
                )
            ],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("object in tuple", () => {
        const code = `
export function tuple(x: [string, { a: number }]);
`
        const actual = fromCode(code)

        expect(actual.tuple).toEqual({
            args: [
                Guess.array(Guess.union(Guess.string(), Guess.object({ a: Guess.number() }))),
            ],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("tuple return", () => {
        const code = `
export function tuple(): [string, boolean]
`
        const actual = fromCode(code)

        expect(actual.tuple).toEqual({
            args: [],
            ret: {
                isAny: false,
                kind: { Array: 1 },
                arrayValueType: {
                    isAny: false,
                    kind: { String: 0.5, Boolean: 0.5 },
                }
            },
            callconv: "Free",
        })
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
            args: [Guess.object({ a: Guess.string(), b: Guess.number() })],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["userObject"]).toEqual({
            args: [Guess.object({ name: Guess.string(), age: Guess.number() })],
            ret: Guess.object({ id: Guess.string() }),
            callconv: "Free",
        })

        expect(actual["configObject"]).toEqual({
            args: [Guess.object({ debug: Guess.boolean(), port: Guess.number() })],
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
        const o = Guess.optional

        expect(actual["optionalObject"]).toEqual({
            args: [
                Guess.object({
                    a: o(Types.string()),
                    b: Guess.number(),
                })
            ],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["allOptional"]).toEqual({
            args: [
                Guess.object({
                    name: o(Types.string()),
                    age: o(Types.number()),
                })
            ],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["mixedOptional"]).toEqual({
            args: [
                Guess.object({
                    required: Guess.string(),
                    optional: o(Types.number()),
                })
            ],
            ret: Guess.object({ result: o(Types.boolean()) }),
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
            args: [
                Guess.object({
                    a: Guess.object({ b: Guess.string(), c: Guess.number() }),
                })
            ],
            ret: Guess.undefined(),
            callconv: "Free",
        })

        expect(actual["deepNested"]).toEqual({
            args: [
                Guess.object({
                    user: Guess.object({
                        profile: Guess.object({ name: Guess.string(), age: Guess.number() }),
                    }),
                })
            ],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["arrayNested"]).toEqual({
            args: [
                Guess.object({
                    items: Guess.array(Guess.object({ id: Guess.string(), value: Guess.number() })),
                })
            ],
            ret: Guess.object({
                results: Guess.array(Guess.object({ success: Guess.boolean() })),
            }),
            callconv: "Free",
        })
    })

    test("record", () => {
        const code = `
export function foo(x: Record<string, unknown>);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.object({})],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("index signatures", () => {
        const code = `
interface B {
    [key: string]: number
}
export function foo(x: B);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.object({})],
            ret: Guess.any(),
            callconv: "Free",
        })
    })
})

describe("function overloading", () => {
    test("overload with no param", () => {
        const code = `
export function foo(): void;
export function foo(x: number): number;
`
        const actual = fromCode(code)

        expect(actual.foo).toEqual({
            args: [Guess.optional(Types.number())],
            ret: Guess.optional(Types.number()),
            callconv: "Free"
        })
    })

    test("basic overloading", () => {
        const code = `
export function overloaded(x: number): string;
export function overloaded(x: number, y: string): boolean;
`
        const actual = fromCode(code)

        expect(actual["overloaded"]).toEqual({
            args: [Guess.number(), Guess.optional(Types.string())],
            ret: Guess.union(Guess.string(), Guess.boolean()),
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

        expect(actual["complexOverload"]).toEqual({
            args: [
                {
                    isAny: false,
                    kind: { String: 0.5, Number: 0.25, Object: 0.25 },
                    objectShape: { a: Guess.string() },
                },
                { isAny: false, kind: { Undefined: 0.875, Boolean: 0.125 } },
            ],
            ret: {
                isAny: false,
                kind: { Number: 0.25, String: 0.25, Undefined: 0.25, Object: 0.25 },
                objectShape: { b: Guess.number() },
            },
            callconv: "Free"
        })
    })
})

describe("classes", () => {
    test("simple class without constructor", () => {
        const code = `
export class A {}
`
        const actual = fromCode(code)

        expect(actual.A).toEqual({
            args: [],
            ret: Guess.class("A"),
            callconv: "Constructor",
        })
    })

    test("simple class with constructor", () => {
        const code = `
export class A {
    constructor();
}
`
        const actual = fromCode(code)

        expect(actual.A).toEqual({
            args: [],
            ret: Guess.class("A"),
            callconv: "Constructor",
        })
    })

    test("static constructor", () => {
        const code = `
export class T {
    static from(): T;
    static fromAsync(): Promise<T>;
}
`
        const actual = fromCode(code)

        expect(actual.T).toEqual({ args: [], ret: Guess.class("T"), callconv: "Constructor" })
        expect(actual["T.from"]).toEqual({
            args: [],
            ret: Guess.class("T"),
            callconv: "Free",
        })
        expect(actual["T.fromAsync"]).toEqual({
            args: [],
            ret: Guess.class("T"),
            callconv: "Free",
        })
    })

    test("static method", () => {
        const code = `
export class NoConstructorClass {
    static staticMethod(): number;
}
`
        const actual = fromCode(code)

        expect(actual["NoConstructorClass"]).toEqual({
            args: [],
            ret: Guess.class("NoConstructorClass" ),
            callconv: "Constructor",
        })

        expect(actual["NoConstructorClass.staticMethod"]).toEqual({
            args: [],
            ret: Guess.number(),
            callconv: "Free",
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
            args: [Guess.optional(Types.string())],
            ret: Guess.class("SimpleClass" ),
            callconv: "Constructor",
        })
    })

    test("methods", () => {
        const code = `
export class MethodClass {
    simpleMethod(): string;
    methodWithParams(x: number, y: boolean): void;
    methodReturningObject(): { a: string; b: number };
}
`
        const actual = fromCode(code)

        expect(actual["MethodClass"]).toEqual({
            args: [],
            ret: Guess.class("MethodClass"),
            callconv: "Constructor",
        })

        expect(actual["MethodClass.simpleMethod"]).toEqual({
            args: [Guess.class("MethodClass")],
            ret: Guess.string(),
            callconv: "Method",
        })

        expect(actual["MethodClass.methodWithParams"]).toEqual({
            args: [Guess.class("MethodClass"), Guess.number(), Guess.boolean()],
            ret: Guess.undefined(),
            callconv: "Method",
        })

        expect(actual["MethodClass.methodReturningObject"]).toEqual({
            args: [Guess.class("MethodClass")],
            ret: Guess.object({ a: Guess.string(), b: Guess.number() }),
            callconv: "Method",
        })
    })

    test("inheritance", () => {
        const code = `
export class Base {
    base(x: number): void;
}

export class Derived extends Base {
    derived(): void;
}
`
        const actual = fromCode(code)

        expect(actual["Base"]).toEqual({
            args: [],
            ret: Guess.class("Base"),
            callconv: "Constructor",
        })

        expect(actual["Base.base"]).toEqual({
            args: [Guess.class("Base"), Guess.number()],
            ret: Guess.undefined(),
            callconv: "Method",
        })

        expect(actual["Derived"]).toEqual({
            args: [],
            ret: Guess.class("Derived"),
            callconv: "Constructor",
        })

        expect(actual["Derived.base"]).toEqual({
            args: [Guess.class("Derived"), Guess.number()],
            ret: Guess.undefined(),
            callconv: "Method",
        })

        expect(actual["Derived.derived"]).toEqual({
            args: [Guess.class("Derived")],
            ret: Guess.undefined(),
            callconv: "Method",
        })
    })

    test("static methods", () => {
        const code = `
export class StaticClass {
    static staticMethod(): string;
    static staticWithParams(x: number): boolean;
    instanceMethod(): void;
}
`
        const actual = fromCode(code)

        expect(actual["StaticClass"]).toEqual({
            args: [],
            ret: Guess.class("StaticClass"),
            callconv: "Constructor",
        })

        expect(actual["StaticClass.staticMethod"]).toEqual({
            args: [],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual["StaticClass.staticWithParams"]).toEqual({
            args: [Guess.number()],
            ret: Guess.boolean(),
            callconv: "Free",
        })

        expect(actual["StaticClass.instanceMethod"]).toEqual({
            args: [Guess.class("StaticClass")],
            ret: Guess.undefined(),
            callconv: "Method",
        })
    })

    test("use declared classes", () => {
        const code = `
export class A {}
export function foo(a: A);
`
        const actual = fromCode(code)

        expect(actual.A).toEqual({
            args: [],
            ret: Guess.class("A"),
            callconv: "Constructor",
        })

        expect(actual.foo).toEqual({
            args: [Guess.class("A")],
            ret: Guess.any(),
            callconv: "Free",
        })
    })
})

describe("aliases", () => {
    test("custom classes via aliases", () => {
        const code = `
class A {}
type Data = A;
export function foo(d: Data);
`
        const actual = fromCode(code)

        expect(actual.foo).toEqual({
            args: [Guess.class("A")],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("builtin classes via aliases", () => {
        const code = `
type Data = Uint8Array;
export function foo(d: Data);
`
        const actual = fromCode(code)

        expect(actual.foo).toEqual({
            args: [Guess.class("Uint8Array")],
            ret: Guess.any(),
            callconv: "Free"
        })
    })

    test("unions of custom and builtin types", () => {
        const code = `
class A = {}
type Data = Uint8Array | ArrayBuffer | A | string;
export function foo(d: Data);
`
        const actual = fromCode(code)

        expect(actual.foo).toEqual({
            args: [
                Guess.union(
                    Guess.class("Uint8Array"),
                    Guess.class("ArrayBuffer"),
                    Guess.class("A"),
                    Guess.string(),
                ),
            ],
            ret: Guess.any(),
            callconv: "Free"
        })
    })
})

describe("generics", () => {
    test("unconstrained is any", () => {
        const code = `
export function foo<T>(x: T);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.any()],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("constrained is promoted to the constraint", () => {
        const code = `
export function foo<T extends number>(x: T);
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.number()],
            ret: Guess.any(),
            callconv: "Free",
        })
    })

    test("unconstrained return type", () => {
        const code = `
export function foo<T>(x: T): T;
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.any()],
            ret: Guess.any(),
            callconv: "Free"
        })
    })

    test("constrained return type", () => {
        const code = `
export function foo<T extends number>(x: T): T;
`
        const actual = fromCode(code)
        expect(actual.foo).toEqual({
            args: [Guess.number()],
            ret: Guess.number(),
            callconv: "Free"
        })
    })
})

describe("recursive and complex types", () => {
    test.todo("recursive object type does not stack overflow", () => {
        const code = `
interface Node {
    parent: Node;
    name: string;
}
export function visit(node: Node): void;
`
        const actual = fromCode(code)

        expect(actual.visit).toEqual({
            args: [Guess.object({})],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("intersection with non-object members", () => {
        const code = `
type Tagged = string & { __brand: true };
export function tag(x: Tagged): void;
`
        const actual = fromCode(code)

        expect(actual.tag).toEqual({
            args: [Guess.object({__brand: Guess.boolean()})],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })

    test("object with many properties is treated as any", () => {
        const props = Array.from({ length: 40 }, (_, i) => `p${i}: string`).join("; ")
        const code = `
export function big(x: { ${props} }): void;
`
        const actual = fromCode(code)

        expect(actual.big).toEqual({
            args: [Guess.any()],
            ret: Guess.undefined(),
            callconv: "Free",
        })
    })
})

describe("exports", () => {
    test("ambient module declaration", () => {
        const code = `
declare module 'my-module' {
    function hello(name: string): string;
    class Widget {
        render(): void;
    }
}
`
        const actual = fromCode(code)

        expect(actual.hello).toEqual({
            args: [Guess.string()],
            ret: Guess.string(),
            callconv: "Free",
        })

        expect(actual.Widget).toEqual({
            args: [],
            ret: Guess.class("Widget"),
            callconv: "Constructor",
        })

        expect(actual["Widget.render"]).toEqual({
            args: [Guess.class("Widget")],
            ret: Guess.undefined(),
            callconv: "Method",
        })
    })

    test("export equals variable infers properties of its type", () => {
        const code = `
declare const lib: LibStatic;
declare namespace lib {}
interface LibStatic {
    chunk(arr: string[]): string[][];
    compact(arr: any[]): any[];
}
export = lib;
`
        const actual = fromCode(code)

        expect(actual.chunk).toEqual({
            args: [Guess.array(Guess.string())],
            ret: Guess.array(Guess.array(Guess.string())),
            callconv: "Free",
        })

        expect(actual.compact).toEqual({
            args: [Guess.array(Guess.any())],
            ret: Guess.array(Guess.any()),
            callconv: "Free",
        })
    })

    test("export equals namespace uses regular export path", () => {
        const code = `
declare namespace Lib {
    function hello(x: string): number;
    class Widget {
        render(): void;
    }
}
export = Lib;
`
        const actual = fromCode(code)

        expect(actual.hello).toEqual({
            args: [Guess.string()],
            ret: Guess.number(),
            callconv: "Free",
        })

        expect(actual.Widget).toEqual({
            args: [],
            ret: Guess.class("Widget"),
            callconv: "Constructor",
        })

        expect(actual["Widget.render"]).toEqual({
            args: [Guess.class("Widget")],
            ret: Guess.undefined(),
            callconv: "Method",
        })
    })

    test("skip constants that are not functions", () => {
        const code = `
export declare const defaults: string[];
`
        const actual = fromCode(code)
        expect(actual.defaults).toBeUndefined()
    })
})

describe("builtins", () => {
    test("Uint8Array", () => {
        const code = `
export function foo(a: Uint8Array): Uint8Array;
`
        const actual = fromCode(code)

        expect(actual.foo).toEqual({
            args: [Guess.class("Uint8Array")],
            ret: Guess.class("Uint8Array"),
            callconv: "Free",
        })
    })
})

describe("interfaces", () => {
    test("inheritance", () => {
        const code = `
interface BaseNode {
    visit(): any;
}
export class Node implements BaseNode {}
`
        const actual = fromCode(code)

        expect(actual["Node"]).toEqual({
            args: [],
            ret: Guess.class("Node"),
            callconv: "Constructor"
        })

        expect(actual["Node.visit"]).toEqual({
            args: [Guess.class("Node")],
            ret: Guess.any(),
            callconv: "Method"
        })
    })

    test("more inheritance", () => {
        const code = `
interface BaseBaseNode {
    visit();
}
interface BaseNode extends BaseBaseNode {
    otherVisit();
}
export class Node implements BaseNode {}
`
        const actual = fromCode(code)

        expect(actual.Node).toEqual({ args: [], ret: Guess.class("Node"), callconv: "Constructor" })
        expect(actual["Node.visit"]).toEqual({ args: [Guess.class("Node")], ret: Guess.any(), callconv: "Method" })
        expect(actual["Node.otherVisit"]).toEqual({ args: [Guess.class("Node")], ret: Guess.any(), callconv: "Method" })
    })
})

describe("example projects", () => {
    test("tslib __extends", () => {
        const code = `
export declare function __extends(d: Function, b: Function): void;
`
        const actual = fromCode(code)

        expect(actual["__extends"]).toEqual({
            args: [Guess.func(), Guess.func()],
            ret: Guess.undefined(),
            callconv: "Free"
        })
    })

    test("pako deflate", () => {
        const code = `
export = Pako;
export as namespace pako;
declare namespace Pako {
    type Uint8ArrayReturnType = InstanceType<typeof Uint8Array>;
    type Data = Uint8Array | ArrayBuffer;
    interface DeflateFunctionOptions {
        level?: -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined;
        dictionary?: any;
        raw?: boolean | undefined;
    }
    function deflate(data: Data | string, options?: DeflateFunctionOptions): Uint8ArrayReturnType;
}
`
        const actual = fromCode(code)

        expect(actual.deflate).toEqual({
            args: [
                Guess.union(
                    Guess.class("Uint8Array"),
                    Guess.class("ArrayBuffer"),
                    Guess.string()
                ),
                Guess.union(
                    Guess.undefined(),
                    Guess.object({
                        level: Guess.optional(Types.number()),
                        dictionary: Guess.any(),
                        raw: Guess.optional(Types.boolean()),
                    })
                )
            ],
            ret: Guess.class("Uint8Array"),
            callconv: "Free"
        })
    })

    // if there's a class and a function of the same name, prefer the function.
    // ua-parser-js does this so that users can use both `UAParser()` and `new UAParser()`.
    test("ua-parser-js class and function of the same name", () => {
        const code = `
declare namespace UAParser {
    export function UAParser(): number;
    export class UAParser {
        get(): number;
    }
}
export as namespace UAParser;
export = UAParser;
`
        const actual = fromCode(code)

        expect(actual.UAParser).toEqual({
            args: [],
            ret: Guess.class("UAParser"),
            callconv: "Constructor",
        })

        expect(actual["UAParser.get"]).toEqual({
            args: [Guess.class("UAParser")],
            ret: Guess.number(),
            callconv: "Method"
        })

        expect(actual["UAParser.UAParser"]).toBeUndefined()
        expect(actual["UAParser.toString"]).toBeUndefined()
    })

    test("redux has generics with overloads", () => {
        const code = `
type Action<T extends string = string> = {
    type: T;
};
interface UnknownAction extends Action {
    [extraProps: string]: unknown;
}
interface ActionCreator<A, P extends any[] = any[]> {
    (...args: P): A;
}
interface ActionCreatorsMapObject<A = any, P extends any[] = any[]> {
    [key: string]: ActionCreator<A, P>;
}
interface Dispatch<A extends Action = UnknownAction> {
    <T extends A>(action: T, ...extraArgs: any[]): T;
}
export function bindActionCreators<A, C extends ActionCreator<A>>(actionCreator: C, dispatch: Dispatch): C;
export function bindActionCreators<A extends ActionCreator<any>, B extends ActionCreator<any>>(actionCreator: A, dispatch: Dispatch): B;
export function bindActionCreators<A, M extends ActionCreatorsMapObject<A>>(actionCreators: M, dispatch: Dispatch): M;
export function bindActionCreators<M extends ActionCreatorsMapObject, N extends ActionCreatorsMapObject>(actionCreators: M, dispatch: Dispatch): N;
`
        const actual = fromCode(code)
        expect(actual.bindActionCreators).toEqual({
            args: [
                Guess.union(Guess.func(), Guess.object({})),
                Guess.func()
            ],
            ret: Guess.union(Guess.func(), Guess.object({})),
            callconv: "Free",
        })
    })

    test("fast-xml-parser static getMetaDataSymbol", () => {
        const code = `
export class XMLParser {
    static getMetaDataSymbol(): Symbol;
}
`
        const actual = fromCode(code)
        expect(actual["XMLParser.getMetaDataSymbol"]).toEqual({
            args: [],
            ret: Guess.any(),
            callconv: "Free",
        })
    })
})
