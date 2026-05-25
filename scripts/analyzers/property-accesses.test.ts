/**
 * Tests for the object-property-access analyzer in `property-accesses.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e5dc8-2b9c-72bf-a5dc-5357bfc9e29e
 */

import { describe, expect, test } from "bun:test";
import { transformSync } from "@babel/core";
import { getCanonicalFunctionId } from "./function-extract.ts";
import { ObjectPropertyAccessAnalysis } from "./property-accesses.ts";

const FILE = "test.ts";

function analyze(code: string, file: string = FILE): Map<string, number> {
    const a = new ObjectPropertyAccessAnalysis(file);
    transformSync(code, {
        plugins: [a.plugin()],
        code: false,
        ast: false,
        sourceType: "unambiguous",
        babelrc: false,
        configFile: false,
        filename: file,
    });
    return a.map;
}

function topLevelId(file: string = FILE): string {
    return getCanonicalFunctionId({ file, loc: null });
}

/** Property-access count recorded for the top-level script body. */
function top(
    map: Map<string, number>,
    file: string = FILE,
): number | undefined {
    return map.get(topLevelId(file));
}

describe("ObjectPropertyAccessAnalysis", () => {
    // ----- Baseline -------------------------------------------------------

    describe("baseline", () => {
        test("empty source records no accesses at top level", () => {
            const map = analyze("");
            // The top-level entry is only created on the first inc().
            expect(map.size).toBe(0);
        });

        test("source with no property accesses records nothing", () => {
            const map = analyze("const x = 1; const y = x + 2;");
            expect(map.size).toBe(0);
        });

        test("single identifier expression records nothing", () => {
            const map = analyze("x;");
            expect(map.size).toBe(0);
        });
    });

    // ----- MemberExpression ----------------------------------------------

    describe("member expressions", () => {
        test("dot access counts as 1", () => {
            const map = analyze("a.b;");
            expect(top(map)).toBe(1);
        });

        test("computed access counts as 1", () => {
            const map = analyze("a['b'];");
            expect(top(map)).toBe(1);
        });

        test("chained dot access counts each step", () => {
            const map = analyze("a.b.c.d;");
            expect(top(map)).toBe(3);
        });

        test("mixed dot and computed access counts each step", () => {
            const map = analyze("a.b['c'].d;");
            expect(top(map)).toBe(3);
        });

        test("member expression in assignment LHS counts", () => {
            const map = analyze("a.b = 1;");
            expect(top(map)).toBe(1);
        });

        test("method call counts the callee member access", () => {
            const map = analyze("a.b();");
            expect(top(map)).toBe(1);
        });

        test("chained method calls count each member access", () => {
            const map = analyze("a.b().c();");
            expect(top(map)).toBe(2);
        });
    });

    // ----- OptionalMemberExpression --------------------------------------

    describe("optional member expressions", () => {
        test("optional dot access counts as 1", () => {
            const map = analyze("a?.b;");
            expect(top(map)).toBe(1);
        });

        test("optional computed access counts as 1", () => {
            const map = analyze("a?.['b'];");
            expect(top(map)).toBe(1);
        });

        test("chained optional access counts each step", () => {
            const map = analyze("a?.b?.c;");
            expect(top(map)).toBe(2);
        });

        test("mix of optional and regular member access counts each step", () => {
            const map = analyze("a?.b.c;");
            expect(top(map)).toBe(2);
        });
    });

    // ----- Function attribution ------------------------------------------

    describe("function attribution", () => {
        test("accesses inside a function count toward that function only", () => {
            const map = analyze("top.x; function f() { a.b; a.c; }");
            // Top-level: one access.
            expect(top(map)).toBe(1);
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            // Function: two accesses.
            expect(map.get(fnIds[0])).toBe(2);
        });

        test("nested functions each get their own count", () => {
            const map = analyze(
                "function outer() { o.x; function inner() { i.x; i.y; } }",
            );
            // Top-level has no accesses, so it is not in the map.
            expect(top(map)).toBeUndefined();
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(2);
            const counts = fnIds.map((id) => map.get(id)).sort();
            // outer: 1; inner: 2.
            expect(counts).toEqual([1, 2]);
        });

        test("arrow function is counted as a function", () => {
            const map = analyze("const f = (x) => x.y;");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            expect(map.get(fnIds[0])).toBe(1);
        });

        test("anonymous function expression is counted", () => {
            const map = analyze("const f = function () { a.b; };");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            expect(map.get(fnIds[0])).toBe(1);
        });

        test("two functions at different positions get distinct entries", () => {
            const map = analyze(
                "const a = () => { x.y; }; const b = () => { p.q; };",
            );
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(2);
            expect(map.get(fnIds[0])).toBe(1);
            expect(map.get(fnIds[1])).toBe(1);
        });

        test("method call inside a function attributes to that function", () => {
            const map = analyze("function f() { a.b().c; }");
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            // a.b (member) + (...).c (member) = 2.
            expect(map.get(fnIds[0])).toBe(2);
        });
    });

    // ----- Combined -------------------------------------------------------

    describe("combined", () => {
        test("kitchen-sink function aggregates contributions", () => {
            const code = `
                function f(o) {
                    const a = o.x;
                    const b = o?.y;
                    const c = o['z'];
                    o.m().n;
                    return a + b + c;
                }
            `;
            const map = analyze(code);
            const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
            expect(fnIds).toHaveLength(1);
            // Contributions inside f:
            //   o.x       => 1
            //   o?.y      => 1
            //   o['z']    => 1
            //   o.m       => 1
            //   (...).n   => 1
            // = 5
            expect(map.get(fnIds[0])).toBe(5);
            // No top-level accesses.
            expect(top(map)).toBeUndefined();
        });
    });

    // ----- File ID --------------------------------------------------------

    describe("file", () => {
        test("top-level id matches the canonical sentinel for the file", () => {
            const map = analyze("a.b;", "a.ts");
            expect([...map.keys()]).toContain(
                getCanonicalFunctionId({ file: "a.ts", loc: null }),
            );
        });

        test("different file paths yield different top-level ids", () => {
            const a = analyze("a.b;", "a.ts");
            const b = analyze("a.b;", "b.ts");
            expect([...a.keys()]).not.toEqual([...b.keys()]);
        });
    });
});
