/**
 * Tests for the static function extractor in `function-extract.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e389b-a1e9-778a-8ef2-b02cc3462c89
 */

import { describe, expect, test } from "bun:test";
import { transformSync } from "@babel/core";
import {
    type FunctionAttr,
    FunctionExtractor,
    getCanonicalFunctionId,
} from "./function-extract.ts";

const FILE = "test.ts";

function extract(
    code: string,
    file: string,
    library = "test-lib",
): FunctionAttr[] {
    const fnExt = new FunctionExtractor(file, library);
    transformSync(code, {
        plugins: [fnExt.plugin()],
        code: false,
        ast: false,
        sourceType: "unambiguous",
        babelrc: false,
        configFile: false,
        filename: file,
    });
    return fnExt.functions;
}

function pickFn(
    fns: FunctionAttr[],
    predicate: (f: FunctionAttr) => boolean,
): FunctionAttr {
    const match = fns.filter(predicate);
    expect(match).toHaveLength(1);
    return match[0];
}

describe("extract: functions", () => {
    test("empty source produces only the TopLevel row", () => {
        const fns = extract("", FILE);
        expect(fns).toHaveLength(1);
        const top = fns[0];
        expect(top.type).toBe("TopLevel");
        expect(top.name).toBeNull();
        expect(top.async).toBe(false);
        expect(top.generator).toBe(false);
        expect(top.params).toBe(0);
        expect(top.startOffset).toBe(0);
        expect(top.endOffset).toBe(0);
    });

    test("TopLevel row uses the canonical top-level functionId", () => {
        const fns = extract("const x = 1;", FILE);
        const top = pickFn(fns, (f) => f.type === "TopLevel");
        expect(top.id).toBe(getCanonicalFunctionId({ file: FILE, loc: null }));
    });

    test("TopLevel row spans the entire source", () => {
        const code = "function f() {} const x = 1;";
        const fns = extract(code, FILE);
        const top = pickFn(fns, (f) => f.type === "TopLevel");
        expect(top.startOffset).toBe(0);
        expect(top.endOffset).toBe(code.length);
    });

    test("library label is propagated onto every row", () => {
        const fns = extract(
            "function f() {} const g = () => 1;",
            FILE,
            "lib-x",
        );
        for (const f of fns) {
            expect(f.library).toBe("lib-x");
            expect(f.file).toBe(FILE);
        }
    });

    // ----- per-kind extraction -------------------------------------------

    describe("function kinds", () => {
        test("FunctionDeclaration captures name and params", () => {
            const fns = extract("function foo(a, b, c) { return a; }", FILE);
            const foo = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(foo.name).toBe("foo");
            expect(foo.params).toBe(3);
            expect(foo.async).toBe(false);
            expect(foo.generator).toBe(false);
        });

        test("named FunctionExpression captures its name", () => {
            const fns = extract("const f = function bar() {};", FILE);
            const bar = pickFn(fns, (f) => f.type === "FunctionExpression");
            expect(bar.name).toBe("bar");
        });

        test("anonymous FunctionExpression has null name", () => {
            const fns = extract("const f = function () {};", FILE);
            const fe = pickFn(fns, (f) => f.type === "FunctionExpression");
            expect(fe.name).toBeNull();
        });

        test("ArrowFunctionExpression has null name", () => {
            const fns = extract("const f = (x) => x;", FILE);
            const arrow = pickFn(
                fns,
                (f) => f.type === "ArrowFunctionExpression",
            );
            expect(arrow.name).toBeNull();
            expect(arrow.params).toBe(1);
        });

        test("async arrow sets async=true", () => {
            const fns = extract("const f = async (x) => x;", FILE);
            const arrow = pickFn(
                fns,
                (f) => f.type === "ArrowFunctionExpression",
            );
            expect(arrow.async).toBe(true);
            expect(arrow.generator).toBe(false);
        });

        test("generator function sets generator=true", () => {
            const fns = extract("function* gen() { yield 1; }", FILE);
            const gen = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(gen.generator).toBe(true);
            expect(gen.async).toBe(false);
            expect(gen.name).toBe("gen");
        });

        test("async generator sets both flags", () => {
            const fns = extract("async function* gen() { yield 1; }", FILE);
            const gen = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(gen.async).toBe(true);
            expect(gen.generator).toBe(true);
        });

        test("ClassMethod captures method name", () => {
            const fns = extract("class C { method(a, b) { return a; } }", FILE);
            const m = pickFn(fns, (f) => f.type === "ClassMethod");
            expect(m.name).toBe("method");
            expect(m.params).toBe(2);
        });

        test("ClassPrivateMethod prefixes name with #", () => {
            const fns = extract("class C { #priv() { return 1; } }", FILE);
            const m = pickFn(fns, (f) => f.type === "ClassPrivateMethod");
            expect(m.name).toBe("#priv");
        });

        test("ObjectMethod captures key name", () => {
            const fns = extract(
                "const o = { greet(name) { return name; } };",
                FILE,
            );
            const m = pickFn(fns, (f) => f.type === "ObjectMethod");
            expect(m.name).toBe("greet");
            expect(m.params).toBe(1);
        });

        test("string-keyed method captures the literal value", () => {
            const fns = extract("const o = { 'with space'() {} };", FILE);
            const m = pickFn(fns, (f) => f.type === "ObjectMethod");
            expect(m.name).toBe("with space");
        });

        test("computed-key method falls back to null", () => {
            const fns = extract("const k = 'x'; const o = { [k]() {} };", FILE);
            const m = pickFn(fns, (f) => f.type === "ObjectMethod");
            expect(m.name).toBeNull();
        });

        test("rest and default params each count once", () => {
            const fns = extract("function f(a, b = 1, ...rest) {}", FILE);
            const f = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(f.params).toBe(3);
        });
    });

    // ----- nesting & uniqueness ------------------------------------------

    describe("nesting", () => {
        test("nested functions each get their own row", () => {
            const fns = extract(
                "function outer() { function inner() {} }",
                FILE,
            );
            const decls = fns.filter((f) => f.type === "FunctionDeclaration");
            expect(decls).toHaveLength(2);
            expect(decls.map((f) => f.name).sort()).toEqual(["inner", "outer"]);
        });

        test("function ids are unique across all rows", () => {
            const code = `
                function f(x) { if (x) return 1; }
                const g = () => 2;
                class C { method() {} #priv() {} }
                const o = { m() {} };
            `;
            const fns = extract(code, FILE);
            const ids = fns.map((f) => f.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    // ----- ID properties --------------------------------------------------

    describe("function ids", () => {
        test("are stable across runs for the same source", () => {
            const code = "function f() {} const g = () => 1;";
            const a = extract(code, FILE).map((x) => x.id);
            const b = extract(code, FILE).map((x) => x.id);
            expect(a).toEqual(b);
        });

        test("differ when the file path changes", () => {
            const code = "function f() {}";
            const ids1 = extract(code, "a.ts").map((x) => x.id);
            const ids2 = extract(code, "b.ts").map((x) => x.id);
            expect(ids1).not.toEqual(ids2);
        });

        test("match getCanonicalFunctionId for each emitted row", () => {
            const code =
                "function f() {} const g = () => 1; class C { m() {} }";
            const fns = extract(code, FILE);
            for (const f of fns) {
                const expected =
                    f.type === "TopLevel"
                        ? getCanonicalFunctionId({ file: FILE, loc: null })
                        : getCanonicalFunctionId({
                              file: FILE,
                              loc: {
                                  start: {
                                      line: f.startLine,
                                      column: f.startCol,
                                      index: f.startOffset,
                                  },
                                  end: {
                                      line: f.endLine,
                                      column: f.endCol,
                                      index: f.endOffset,
                                  },
                                  // biome-ignore lint/suspicious/noExplicitAny: SourceLocation has more fields we don't need
                              } as any,
                          });
                expect(f.id).toBe(expected);
            }
        });
    });
});
