/**
 * Tests for the cyclomatic complexity analyzer in `complexity.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e38c6-3412-766b-9efe-35754f598524
 */

import { describe, expect, test } from "bun:test";
import { transformSync } from "@babel/core";
import { ComplexityAnalysis } from "./complexity.ts";
import { getCanonicalFunctionId } from "./function-extract.ts";

const FILE = "test.ts";

function analyze(code: string, file: string = FILE): Map<string, number> {
    const ca = new ComplexityAnalysis(file);
    transformSync(code, {
        plugins: [ca.plugin()],
        code: false,
        ast: false,
        sourceType: "unambiguous",
        babelrc: false,
        configFile: false,
        filename: file,
    });
    return ca.map;
}

function topLevelId(file: string = FILE): string {
    return getCanonicalFunctionId({ file, loc: null });
}

/** Return the complexity recorded for the top-level script body. */
function top(
    map: Map<string, number>,
    file: string = FILE,
): number | undefined {
    return map.get(topLevelId(file));
}

describe("ComplexityAnalysis", () => {
    // ----- Baseline -------------------------------------------------------

    describe("baseline", () => {
        test("empty source has top-level complexity 1", () => {
            const map = analyze("");
            expect(map.size).toBe(1);
            expect(top(map)).toBe(1);
        });

        test("source with no branches has top-level complexity 1", () => {
            const map = analyze("const x = 1; const y = x + 2;");
            expect(map.size).toBe(1);
            expect(top(map)).toBe(1);
        });

        test("function with no branches has complexity 1", () => {
            const map = analyze("function f() { return 1; }");
            // Top-level + one function entry.
            expect(map.size).toBe(2);
            expect(top(map)).toBe(1);
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            expect(map.get(fnIds[0])).toBe(1);
        });
    });

    // ----- Control flow constructs ---------------------------------------

    describe("control flow", () => {
        test("if statement adds 1", () => {
            const map = analyze("if (x) y;");
            expect(top(map)).toBe(2);
        });

        test("if/else still only adds 1 (no count for else)", () => {
            const map = analyze("if (x) y; else z;");
            expect(top(map)).toBe(2);
        });

        test("nested if adds 1 each", () => {
            const map = analyze("if (a) { if (b) c; }");
            expect(top(map)).toBe(3);
        });

        test("ternary adds 1", () => {
            const map = analyze("const v = c ? a : b;");
            expect(top(map)).toBe(2);
        });

        test("for loop adds 1", () => {
            const map = analyze("for (let i = 0; i < n; i++) body();");
            expect(top(map)).toBe(2);
        });

        test("for-in loop adds 1", () => {
            const map = analyze("for (const k in o) body(k);");
            expect(top(map)).toBe(2);
        });

        test("for-of loop adds 1", () => {
            const map = analyze("for (const v of xs) body(v);");
            expect(top(map)).toBe(2);
        });

        test("while loop adds 1", () => {
            const map = analyze("while (x) body();");
            expect(top(map)).toBe(2);
        });

        test("do/while loop adds 1", () => {
            const map = analyze("do body(); while (x);");
            expect(top(map)).toBe(2);
        });

        test("catch clause adds 1", () => {
            const map = analyze("try { a; } catch (e) { b; }");
            expect(top(map)).toBe(2);
        });

        test("try/finally without catch adds 0", () => {
            const map = analyze("try { a; } finally { b; }");
            expect(top(map)).toBe(1);
        });
    });

    // ----- Logical / optional / assignment -------------------------------

    describe("logical and optional", () => {
        test("logical && adds 1", () => {
            const map = analyze("const v = a && b;");
            expect(top(map)).toBe(2);
        });

        test("logical || adds 1", () => {
            const map = analyze("const v = a || b;");
            expect(top(map)).toBe(2);
        });

        test("logical ?? adds 1", () => {
            const map = analyze("const v = a ?? b;");
            expect(top(map)).toBe(2);
        });

        test("chained logicals each add 1", () => {
            const map = analyze("const v = a && b && c;");
            expect(top(map)).toBe(3);
        });

        test("optional member access adds 1", () => {
            const map = analyze("const v = a?.b;");
            expect(top(map)).toBe(2);
        });

        test("non-optional member access adds 0", () => {
            const map = analyze("const v = a.b;");
            expect(top(map)).toBe(1);
        });

        test("optional call adds 1", () => {
            const map = analyze("a?.();");
            expect(top(map)).toBe(2);
        });

        test("logical assignment &&= adds 1", () => {
            const map = analyze("let a = 1; a &&= b;");
            expect(top(map)).toBe(2);
        });

        test("logical assignment ||= adds 1", () => {
            const map = analyze("let a = 1; a ||= b;");
            expect(top(map)).toBe(2);
        });

        test("logical assignment ??= adds 1", () => {
            const map = analyze("let a = 1; a ??= b;");
            expect(top(map)).toBe(2);
        });

        test("plain assignment does not add", () => {
            const map = analyze("let a = 1; a = 2;");
            expect(top(map)).toBe(1);
        });
    });

    // ----- Switch ---------------------------------------------------------

    describe("switch", () => {
        test("each non-default case adds 1", () => {
            const map = analyze(
                "switch (x) { case 1: a(); break; case 2: b(); break; }",
            );
            expect(top(map)).toBe(3);
        });

        test("default case does not add", () => {
            const map = analyze("switch (x) { default: a(); }");
            expect(top(map)).toBe(1);
        });

        test("cases plus default count only the cases", () => {
            const map = analyze(
                "switch (x) { case 1: a(); break; default: b(); }",
            );
            expect(top(map)).toBe(2);
        });
    });

    // ----- Assignment pattern (default parameter) ------------------------

    describe("assignment pattern", () => {
        test("default parameter adds 1 to its function", () => {
            const map = analyze("function f(a = 1) { return a; }");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            expect(map.get(fnIds[0])).toBe(2);
            expect(top(map)).toBe(1);
        });

        test("multiple default parameters each add 1", () => {
            const map = analyze("function f(a = 1, b = 2) { return a + b; }");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(map.get(fnIds[0])).toBe(3);
        });
    });

    // ----- Function attribution ------------------------------------------

    describe("function attribution", () => {
        test("branches inside a function count toward that function only", () => {
            const map = analyze(
                "if (top) a; function f() { if (x) y; if (z) w; }",
            );
            // Top-level: base 1 + one if = 2.
            expect(top(map)).toBe(2);
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            // Function: base 1 + two ifs = 3.
            expect(map.get(fnIds[0])).toBe(3);
        });

        test("nested functions each get their own complexity", () => {
            const map = analyze(
                "function outer() { if (o) {}; function inner() { if (i) {} if (j) {} } }",
            );
            // Top-level base only.
            expect(top(map)).toBe(1);
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(2);
            const complexities = fnIds.map((id) => map.get(id)).sort();
            // outer: 1 + 1 if = 2; inner: 1 + 2 ifs = 3.
            expect(complexities).toEqual([2, 3]);
        });

        test("arrow function is counted as a function", () => {
            const map = analyze("const f = (x) => x ? 1 : 2;");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            // base 1 + ternary = 2.
            expect(map.get(fnIds[0])).toBe(2);
        });

        test("anonymous function expression is counted", () => {
            const map = analyze("const f = function () { if (x) y; };");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            expect(map.get(fnIds[0])).toBe(2);
        });

        test("two anonymous functions at different positions get distinct entries", () => {
            const map = analyze(
                "const a = () => { if(x) y; }; const b = () => { if(z) w; };",
            );
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(2);
            expect(map.get(fnIds[0])).toBe(2);
            expect(map.get(fnIds[1])).toBe(2);
        });
    });

    // ----- Combined -------------------------------------------------------

    describe("combined", () => {
        test("kitchen-sink function aggregates contributions", () => {
            const code = `
                function f(x = 0) {
                    if (x > 0) return x; else return -x;
                    for (let i = 0; i < 10; i++) sink(i);
                    try { risky(); } catch (e) { handle(e); }
                    switch (x) { case 1: a(); break; default: b(); }
                    const y = x ? a : b;
                    const z = x && (a || c);
                    const w = a?.b;
                }
            `;
            const map = analyze(code);
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            // Contributions inside f:
            //   1 (entry)
            // + 1 (default param x = 0)
            // + 1 (if)
            // + 1 (for)
            // + 1 (catch)
            // + 1 (switch case 1; default contributes 0)
            // + 1 (ternary)
            // + 1 (&&) + 1 (||)
            // + 1 (optional member ?.)
            // = 10
            expect(map.get(fnIds[0])).toBe(10);
            // Top-level only has the base count.
            expect(top(map)).toBe(1);
        });
    });

    // ----- File ID --------------------------------------------------------

    describe("file", () => {
        test("top-level id matches the canonical sentinel for the file", () => {
            const map = analyze("if (a) b;", "a.ts");
            expect([...map.keys()]).toContain(
                getCanonicalFunctionId({ file: "a.ts", loc: null }),
            );
        });

        test("different file paths yield different top-level ids", () => {
            const a = analyze("if (a) b;", "a.ts");
            const b = analyze("if (a) b;", "b.ts");
            const aKeys = [...a.keys()];
            const bKeys = [...b.keys()];
            expect(aKeys).not.toEqual(bKeys);
        });
    });
});
