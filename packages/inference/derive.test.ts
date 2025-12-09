// SPDX-License-Identifier: AGPL-3.0-or-later

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect } from "bun:test";

import { deriveFromDeclFile } from "./derive.js";
import { Guess } from "./common.js";

test("unwrap promise", async () => {
    const code = `
export function sleep(ms: number): Promise<boolean>;
`;
    const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
    Bun.write(tmpFile, code);
    const actual = deriveFromDeclFile(tmpFile);

    expect(actual["sleep"]).not.toBeNil();
    expect(actual["sleep"].args[0]).toEqual(Guess.number());
    expect(actual["sleep"].ret).toEqual(Guess.boolean());
});

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
`;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["testString"]).not.toBeNil();
        expect(actual["testString"].args[0]).toEqual(Guess.string());
        expect(actual["testString"].ret).toEqual(Guess.string());

        expect(actual["testNumber"]).not.toBeNil();
        expect(actual["testNumber"].args[0]).toEqual(Guess.number());
        expect(actual["testNumber"].ret).toEqual(Guess.number());

        expect(actual["testBoolean"]).not.toBeNil();
        expect(actual["testBoolean"].args[0]).toEqual(Guess.boolean());
        expect(actual["testBoolean"].ret).toEqual(Guess.boolean());

        expect(actual["testVoid"]).not.toBeNil();
        expect(actual["testVoid"].args).toBeArrayOfSize(0);
        expect(actual["testVoid"].ret).toEqual(Guess.undefined());

        expect(actual["testNull"]).not.toBeNil();
        expect(actual["testNull"].args).toBeArrayOfSize(0);
        expect(actual["testNull"].ret).toEqual(Guess.null());

        expect(actual["testUndefined"]).not.toBeNil();
        expect(actual["testUndefined"].args).toBeArrayOfSize(0);

        expect(actual["testUndefined"].ret).toEqual(Guess.undefined());

        expect(actual["multipleParams"]).not.toBeNil();
        expect(actual["multipleParams"].args).toHaveLength(3);
        expect(actual["multipleParams"].args[0]).toEqual(Guess.string());
        expect(actual["multipleParams"].args[1]).toEqual(Guess.number());
        expect(actual["multipleParams"].args[2]).toEqual(Guess.boolean());
        expect(actual["multipleParams"].ret).toEqual(Guess.undefined());
    });

    test("literal types", async () => {
        const code = `
export function testStringLiteral(x: "hello"): "world";
export function testNumberLiteral(x: 42): 24;
export function testBooleanLiteral(x: true): false;
`;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["testStringLiteral"]).not.toBeNil();
        expect(actual["testStringLiteral"].args[0]).toEqual(Guess.string());
        expect(actual["testStringLiteral"].ret).toEqual(Guess.string());

        expect(actual["testNumberLiteral"]).not.toBeNil();
        expect(actual["testNumberLiteral"].args[0]).toEqual(Guess.number());
        expect(actual["testNumberLiteral"].ret).toEqual(Guess.number());

        expect(actual["testBooleanLiteral"]).not.toBeNil();
        expect(actual["testBooleanLiteral"].args[0]).toEqual(Guess.boolean());
        expect(actual["testBooleanLiteral"].ret).toEqual(Guess.boolean());
    });

    test("optional parameters", () => {
        const code = `
        export function optionalSingle(x: string, y?: number): boolean;
        export function optionalMultiple(x: number, y?: string, z?: boolean): void;
        export function optionalAll(x?: string, y?: number, z?: boolean): string;
        export function mixedOptional(x: string, y: number, z?: boolean, w?: string): { result: number };
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["optionalSingle"]).not.toBeNil();
        expect(actual["optionalSingle"].args).toHaveLength(2);
        expect(actual["optionalSingle"].args[0]).toEqual(Guess.string());
        expect(actual["optionalSingle"].args[1]).toEqual(
            Guess.union(Guess.undefined(), Guess.number()),
        );
        expect(actual["optionalSingle"].ret).toEqual(Guess.boolean());

        expect(actual["optionalMultiple"]).not.toBeNil();
        expect(actual["optionalMultiple"].args).toHaveLength(3);
        expect(actual["optionalMultiple"].args[0]).toEqual(Guess.number());
        expect(actual["optionalMultiple"].args[1]).toEqual(
            Guess.union(Guess.undefined(), Guess.string()),
        );
        expect(actual["optionalMultiple"].args[2]).toEqual(
            Guess.union(Guess.undefined(), Guess.boolean()),
        );
        expect(actual["optionalMultiple"].ret).toEqual(Guess.undefined());

        expect(actual["optionalAll"]).not.toBeNil();
        expect(actual["optionalAll"].args).toHaveLength(3);
        expect(actual["optionalAll"].args[0]).toEqual(
            Guess.union(Guess.undefined(), Guess.string()),
        );
        expect(actual["optionalAll"].args[1]).toEqual(
            Guess.union(Guess.undefined(), Guess.number()),
        );
        expect(actual["optionalAll"].args[2]).toEqual(
            Guess.union(Guess.undefined(), Guess.boolean()),
        );
        expect(actual["optionalAll"].ret).toEqual(Guess.string());

        expect(actual["mixedOptional"]).not.toBeNil();
        expect(actual["mixedOptional"].args).toHaveLength(4);
        expect(actual["mixedOptional"].args[0]).toEqual(Guess.string());
        expect(actual["mixedOptional"].args[1]).toEqual(Guess.number());
        expect(actual["mixedOptional"].args[2]).toEqual(
            Guess.union(Guess.undefined(), Guess.boolean()),
        );
        expect(actual["mixedOptional"].args[3]).toEqual(
            Guess.union(Guess.undefined(), Guess.string()),
        );
        expect(actual["mixedOptional"].ret).toEqual(
            Guess.object({ result: Guess.number() }),
        );
    });
});

describe("union types", () => {
    test("simple unions", () => {
        const code = `
        export function stringOrNumber(x: string | number): boolean;
        export function booleanOrString(x: boolean | string): void;
        export function numberOrBoolean(x: number | boolean): string | number;
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["stringOrNumber"]).not.toBeNil();
        expect(actual["stringOrNumber"].args[0]).toEqual(
            Guess.union(Guess.string(), Guess.number()),
        );
        expect(actual["stringOrNumber"].ret).toEqual(Guess.boolean());

        expect(actual["booleanOrString"]).not.toBeNil();
        expect(actual["booleanOrString"].args[0]).toEqual(
            Guess.union(Guess.boolean(), Guess.string()),
        );
        expect(actual["booleanOrString"].ret).toEqual(Guess.undefined());

        expect(actual["numberOrBoolean"]).not.toBeNil();
        expect(actual["numberOrBoolean"].args[0]).toEqual(
            Guess.union(Guess.number(), Guess.boolean()),
        );
        expect(actual["numberOrBoolean"].ret).toEqual(
            Guess.union(Guess.string(), Guess.number()),
        );
    });

    test("mixed literal unions", () => {
        const code = `
        export function mixedLiterals(x: string | "hello" | 42 | true): void;
        export function literalUnion(x: "a" | "b" | "c"): "x" | "y" | "z";
        export function numberLiteralUnion(x: 1 | 2 | 3): 4 | 5 | 6;
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["mixedLiterals"]).not.toBeNil();
        // Mixed literals should be converted to their base types
        expect(actual["mixedLiterals"].args[0]).toEqual(
            Guess.union(Guess.string(), Guess.number(), Guess.boolean()),
        );
        expect(actual["mixedLiterals"].ret).toEqual(Guess.undefined());

        expect(actual["literalUnion"]).not.toBeNil();
        expect(actual["literalUnion"].args[0]).toEqual(Guess.string());
        expect(actual["literalUnion"].ret).toEqual(Guess.string());

        expect(actual["numberLiteralUnion"]).not.toBeNil();
        expect(actual["numberLiteralUnion"].args[0]).toEqual(Guess.number());
        expect(actual["numberLiteralUnion"].ret).toEqual(Guess.number());
    });

    test("complex unions", () => {
        const code = `
        export function complexUnion(x: Array<string> | { a: number } | (() => void)): void;
        export function objectUnion(x: { a: string } | { b: number }): { c: boolean };
        export function arrayUnion(x: string[] | number[]): boolean[];
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["complexUnion"]).not.toBeNil();
        expect(actual["complexUnion"].args[0]).toEqual(
            Guess.union(
                Guess.array(Guess.string()),
                Guess.object({ a: Guess.number() }),
                Guess.func(),
            ),
        );
        expect(actual["complexUnion"].ret).toEqual(Guess.undefined());

        expect(actual["objectUnion"]).not.toBeNil();
        expect(actual["objectUnion"].args[0]).toEqual(
            Guess.union(
                Guess.object({ a: Guess.string() }),
                Guess.object({ b: Guess.number() }),
            ),
        );
        expect(actual["objectUnion"].ret).toEqual(
            Guess.object({ c: Guess.boolean() }),
        );

        expect(actual["arrayUnion"]).not.toBeNil();
        expect(actual["arrayUnion"].args[0]).toEqual(
            Guess.union(
                Guess.array(Guess.string()),
                Guess.array(Guess.number()),
            ),
        );
        expect(actual["arrayUnion"].ret).toEqual(Guess.array(Guess.boolean()));
    });
});

describe("arrays", () => {
    test("simple arrays", () => {
        const code = `
        export function stringArray(x: string[]): number[];
        export function numberArray(x: Array<number>): boolean;
        export function booleanArray(x: boolean[]): void;
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["stringArray"]).not.toBeNil();
        expect(actual["stringArray"].args[0]).toEqual(
            Guess.array(Guess.string()),
        );
        expect(actual["stringArray"].ret).toEqual(Guess.array(Guess.number()));

        expect(actual["numberArray"]).not.toBeNil();
        expect(actual["numberArray"].args[0]).toEqual(
            Guess.array(Guess.number()),
        );
        expect(actual["numberArray"].ret).toEqual(Guess.boolean());

        expect(actual["booleanArray"]).not.toBeNil();
        expect(actual["booleanArray"].args[0]).toEqual(
            Guess.array(Guess.boolean()),
        );
        expect(actual["booleanArray"].ret).toEqual(Guess.undefined());
    });

    test("complex arrays", () => {
        const code = `
        export function objectArray(x: Array<{ a: string; b: number }>): void;
        export function functionArray(x: (() => void)[]): boolean;
        export function nestedArray(x: Array<string[]>): number[][];
        export function unionElementArray(x: Array<string | number>): boolean;
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["objectArray"]).not.toBeNil();
        expect(actual["objectArray"].args[0]).toEqual(
            Guess.array(Guess.object({ a: Guess.string(), b: Guess.number() })),
        );
        expect(actual["objectArray"].ret).toEqual(Guess.undefined());

        expect(actual["functionArray"]).not.toBeNil();
        // Arrays of functions should be converted to arrays of func()
        expect(actual["functionArray"].args[0]).toEqual(
            Guess.array(Guess.func()),
        );
        expect(actual["functionArray"].ret).toEqual(Guess.boolean());

        expect(actual["nestedArray"]).not.toBeNil();
        expect(actual["nestedArray"].args[0]).toEqual(
            Guess.array(Guess.array(Guess.string())),
        );
        expect(actual["nestedArray"].ret).toEqual(
            Guess.array(Guess.array(Guess.number())),
        );

        expect(actual["unionElementArray"]).not.toBeNil();
        expect(actual["unionElementArray"].args[0]).toEqual(
            Guess.array(Guess.union(Guess.string(), Guess.number())),
        );
        expect(actual["unionElementArray"].ret).toEqual(Guess.boolean());
    });

    test("tuple types", () => {
        const code = `
        export function simpleTuple(x: [string, number, boolean]): void;
        export function objectTuple(x: [string, { a: number }]): boolean;
        export function mixedTuple(x: [string, number, { a: boolean }]): [string, boolean];
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["simpleTuple"]).not.toBeNil();
        // Tuples are converted to arrays with union element types
        expect(actual["simpleTuple"].args[0]).toEqual(
            Guess.array(
                Guess.union(Guess.string(), Guess.number(), Guess.boolean()),
            ),
        );
        expect(actual["simpleTuple"].ret).toEqual(Guess.undefined());

        expect(actual["objectTuple"]).not.toBeNil();
        expect(actual["objectTuple"].args[0]).toEqual(
            Guess.array(
                Guess.union(
                    Guess.string(),
                    Guess.object({ a: Guess.number() }),
                ),
            ),
        );
        expect(actual["objectTuple"].ret).toEqual(Guess.boolean());

        expect(actual["mixedTuple"]).not.toBeNil();
        expect(actual["mixedTuple"].args[0]).toEqual(
            Guess.array(
                Guess.union(
                    Guess.string(),
                    Guess.number(),
                    Guess.object({ a: Guess.boolean() }),
                ),
            ),
        );
        // Return tuple also converted to array with union types
        expect(actual["mixedTuple"].ret).toEqual(
            Guess.array(Guess.union(Guess.string(), Guess.boolean())),
        );
    });
});

describe("objects", () => {
    test("simple objects", () => {
        const code = `
        export function simpleObject(x: { a: string; b: number }): void;
        export function userObject(x: { name: string; age: number }): { id: string };
        export function configObject(x: { debug: boolean; port: number }): void;
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["simpleObject"]).not.toBeNil();
        expect(actual["simpleObject"].args[0]).toEqual(
            Guess.object({ a: Guess.string(), b: Guess.number() }),
        );
        expect(actual["simpleObject"].ret).toEqual(Guess.undefined());

        expect(actual["userObject"]).not.toBeNil();
        expect(actual["userObject"].args[0]).toEqual(
            Guess.object({ name: Guess.string(), age: Guess.number() }),
        );
        expect(actual["userObject"].ret).toEqual(
            Guess.object({ id: Guess.string() }),
        );

        expect(actual["configObject"]).not.toBeNil();
        expect(actual["configObject"].args[0]).toEqual(
            Guess.object({ debug: Guess.boolean(), port: Guess.number() }),
        );
        expect(actual["configObject"].ret).toEqual(Guess.undefined());
    });

    test("optional properties", () => {
        const code = `
        export function optionalObject(x: { a?: string; b: number }): void;
        export function allOptional(x: { name?: string; age?: number }): boolean;
        export function mixedOptional(x: { required: string; optional?: number }): { result?: boolean };
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["optionalObject"]).not.toBeNil();
        expect(actual["optionalObject"].args[0]).toEqual(
            Guess.object({
                a: Guess.union(Guess.undefined(), Guess.string()),
                b: Guess.number(),
            }),
        );
        expect(actual["optionalObject"].ret).toEqual(Guess.undefined());

        expect(actual["allOptional"]).not.toBeNil();
        expect(actual["allOptional"].args[0]).toEqual(
            Guess.object({
                name: Guess.union(Guess.undefined(), Guess.string()),
                age: Guess.union(Guess.undefined(), Guess.number()),
            }),
        );
        expect(actual["allOptional"].ret).toEqual(Guess.boolean());

        expect(actual["mixedOptional"]).not.toBeNil();
        expect(actual["mixedOptional"].args[0]).toEqual(
            Guess.object({
                required: Guess.string(),
                optional: Guess.union(Guess.undefined(), Guess.number()),
            }),
        );
        expect(actual["mixedOptional"].ret).toEqual(
            Guess.object({
                result: Guess.union(Guess.undefined(), Guess.boolean()),
            }),
        );
    });

    test("nested objects", () => {
        const code = `
        export function nestedObject(x: { a: { b: string; c: number } }): void;
        export function deepNested(x: { user: { profile: { name: string; age: number } } }): boolean;
        export function arrayNested(x: { items: { id: string; value: number }[] }): { results: { success: boolean }[] };
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["nestedObject"]).not.toBeNil();
        expect(actual["nestedObject"].args[0]).toEqual(
            Guess.object({
                a: Guess.object({
                    b: Guess.string(),
                    c: Guess.number(),
                }),
            }),
        );
        expect(actual["nestedObject"].ret).toEqual(Guess.undefined());

        expect(actual["deepNested"]).not.toBeNil();
        expect(actual["deepNested"].args[0]).toEqual(
            Guess.object({
                user: Guess.object({
                    profile: Guess.object({
                        name: Guess.string(),
                        age: Guess.number(),
                    }),
                }),
            }),
        );
        expect(actual["deepNested"].ret).toEqual(Guess.boolean());

        expect(actual["arrayNested"]).not.toBeNil();
        expect(actual["arrayNested"].args[0]).toEqual(
            Guess.object({
                items: Guess.array(
                    Guess.object({
                        id: Guess.string(),
                        value: Guess.number(),
                    }),
                ),
            }),
        );
        expect(actual["arrayNested"].ret).toEqual(
            Guess.object({
                results: Guess.array(
                    Guess.object({
                        success: Guess.boolean(),
                    }),
                ),
            }),
        );
    });
});

describe("function overloading", () => {
    test("basic overloading", () => {
        const code = `
        export function overloaded(x: number): string;
        export function overloaded(x: number, y: string): boolean;
        export function noParams(): void;
        export function noParams(x: string): number;
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["overloaded"]).not.toBeNil();
        // Union of return types
        expect(actual["overloaded"].ret).toEqual(
            Guess.union(Guess.string(), Guess.boolean()),
        );
        // Component-wise union of arguments
        expect(actual["overloaded"].args).toHaveLength(2);
        expect(actual["overloaded"].args[0]).toEqual(Guess.number());
        expect(actual["overloaded"].args[1]).toEqual(
            Guess.union(Guess.undefined(), Guess.string()),
        );

        expect(actual["noParams"]).not.toBeNil();
        expect(actual["noParams"].ret).toEqual(
            Guess.union(Guess.undefined(), Guess.number()),
        );
        expect(actual["noParams"].args).toHaveLength(1);
        expect(actual["noParams"].args[0]).toEqual(
            Guess.union(Guess.undefined(), Guess.string()),
        );
    });

    test("complex overloading", () => {
        const code = `
        export function complexOverload(x: string): number;
        export function complexOverload(x: number): string;
        export function complexOverload(x: string, y?: boolean): void;
        export function complexOverload(x: { a: string }): { b: number };
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["complexOverload"]).not.toBeNil();

        // Union of all return types
        expect(actual["complexOverload"].ret).toEqual(
            Guess.union(
                Guess.number(),
                Guess.string(),
                Guess.undefined(),
                Guess.object({ b: Guess.number() }),
            ),
        );

        // Component-wise union of arguments
        expect(actual["complexOverload"].args).toHaveLength(2);

        const firstArg = actual["complexOverload"].args[0];
        expect(firstArg).toEqual({
            isAny: false,
            kind: { String: 0.5, Number: 0.25, Object: 0.25 },
            objectShape: { a: Guess.string() },
        });

        const secondArg = actual["complexOverload"].args[1];
        expect(secondArg).toEqual({
            isAny: false,
            kind: { Boolean: 0.125, Undefined: 0.875 },
        });
    });
});

describe("classes", () => {
    test("simple constructor", async () => {
        const code = `
        export class SimpleClass {
            constructor();
        }
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["SimpleClass"]).not.toBeNil();
        expect(actual["SimpleClass"].args).toBeArrayOfSize(0);
        expect(actual["SimpleClass"].callconv).toEqual("Constructor");
        expect(actual["SimpleClass"].ret).toEqual({
            isAny: false,
            kind: { Class: 1.0 },
            classType: { SimpleClass: 1.0 },
        });
    });

    test("no explicit constructor", async () => {
        const code = `
export class NoConstructorClass {
    method(): string;
    static staticMethod(): number;
}
`;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["NoConstructorClass"]).not.toBeNil();
        expect(actual["NoConstructorClass"].callconv).toEqual("Constructor");
        expect(actual["NoConstructorClass"].args).toHaveLength(0);
        expect(actual["NoConstructorClass"].ret).toEqual({
            isAny: false,
            kind: { Class: 1.0 },
            classType: { NoConstructorClass: 1.0 },
        });

        expect(actual["NoConstructorClass.method"]).not.toBeNil();
        expect(actual["NoConstructorClass.staticMethod"]).not.toBeNil();
    });

    test("constructor overload", () => {
        const code = `
        export class SimpleClass {
            constructor();
            constructor(value: string)
        }
        `;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["SimpleClass"]).not.toBeNil();
        expect(actual["SimpleClass"].args).toBeArrayOfSize(1);
        expect(actual["SimpleClass"].args[0]).toEqual({
            isAny: false,
            kind: { String: 0.5, Undefined: 0.5 },
        });
        expect(actual["SimpleClass"].callconv).toEqual("Constructor");
        expect(actual["SimpleClass"].ret).toEqual({
            isAny: false,
            kind: { Class: 1.0 },
            classType: { SimpleClass: 1.0 },
        });
    });

    test("methods", () => {
        const code = `
export class MethodClass {
constructor();
simpleMethod(): string;
methodWithParams(x: number, y: boolean): void;
methodReturningObject(): { a: string; b: number };
}
`;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["MethodClass"]).not.toBeNil();
        expect(actual["MethodClass.simpleMethod"]).not.toBeNil();
        expect(actual["MethodClass.methodWithParams"]).not.toBeNil();
        expect(actual["MethodClass.methodReturningObject"]).not.toBeNil();

        expect(actual["MethodClass.simpleMethod"].args).toHaveLength(1);
        expect(actual["MethodClass.simpleMethod"].ret).toEqual(Guess.string());

        expect(actual["MethodClass.methodWithParams"].args).toHaveLength(3);
        expect(actual["MethodClass.methodWithParams"].args[1]).toEqual(
            Guess.number(),
        );
        expect(actual["MethodClass.methodWithParams"].args[2]).toEqual(
            Guess.boolean(),
        );
        expect(actual["MethodClass.methodWithParams"].ret).toEqual(
            Guess.undefined(),
        );

        expect(actual["MethodClass.methodReturningObject"].ret).toEqual({
            isAny: false,
            kind: { Object: 1.0 },
            objectShape: {
                a: Guess.string(),
                b: Guess.number(),
            },
        });
    });

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
`;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["Base"]).not.toBeNil();
        expect(actual["Base.base"]).not.toBeNil();
        expect(actual["Derived"]).not.toBeNil();
        expect(actual["Derived.base"]).not.toBeNil();
        expect(actual["Derived.derived"]).not.toBeNil();

        expect(actual["Base.base"].args[0]).toEqual({
            isAny: false,
            kind: {
                Class: 1.0,
            },
            classType: {
                Base: 1.0,
            },
        });

        expect(actual["Base.base"].args[1]).toEqual(Guess.number());

        expect(actual["Derived.base"].args[0]).toEqual({
            isAny: false,
            kind: {
                Class: 1.0,
            },
            classType: {
                Derived: 1.0,
            },
        });

        expect(actual["Derived.base"].args[1]).toEqual(Guess.number());
    });

    test("static methods", async () => {
        const code = `
export class StaticClass {
    constructor();
    static staticMethod(): string;
    static staticWithParams(x: number): boolean;
    instanceMethod(): void;
}
`;
        const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
        Bun.write(tmpFile, code);
        const actual = deriveFromDeclFile(tmpFile);

        expect(actual["StaticClass"]).not.toBeNil();
        expect(actual["StaticClass.staticMethod"]).not.toBeNil();
        expect(actual["StaticClass.staticWithParams"]).not.toBeNil();
        expect(actual["StaticClass.instanceMethod"]).not.toBeNil();

        expect(actual["StaticClass.staticMethod"].callconv).toEqual("Free");
        expect(actual["StaticClass.staticMethod"].args).toHaveLength(0);
        expect(actual["StaticClass.staticMethod"].ret).toEqual(Guess.string());

        expect(actual["StaticClass.staticWithParams"].callconv).toEqual("Free");
        expect(actual["StaticClass.staticWithParams"].args).toHaveLength(1);
        expect(actual["StaticClass.staticWithParams"].args[0]).toEqual(
            Guess.number(),
        );
        expect(actual["StaticClass.staticWithParams"].ret).toEqual(
            Guess.boolean(),
        );

        expect(actual["StaticClass.instanceMethod"].callconv).toEqual("Method");
        expect(actual["StaticClass.instanceMethod"].args).toHaveLength(1);
    });
});
