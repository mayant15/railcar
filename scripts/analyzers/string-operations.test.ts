/**
 * Tests for the string-operations analyzer in `string-operations.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e5de8-f276-77fe-9889-4d4996320e91
 */

import { describe, expect, test } from "bun:test";
import { transformSync } from "@babel/core";
import { getCanonicalFunctionId } from "./function-extract.ts";
import { StringOperationsAnalysis } from "./string-operations.ts";

const FILE = "test.ts";

function analyze(code: string, file: string = FILE): Map<string, number> {
    const a = new StringOperationsAnalysis(file);
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

/** String-operation count recorded for the top-level script body. */
function top(
    map: Map<string, number>,
    file: string = FILE,
): number | undefined {
    return map.get(topLevelId(file));
}

describe("StringOperationsAnalysis", () => {
    test("no operations", () => {
        const map = analyze("const x = 1;");
        expect(top(map)).toBeUndefined();
    });

    test("plain string literal counts", () => {
        const map = analyze(`const x = "hello";`);
        expect(top(map)).toBe(1);
    });

    test("plain template literal (no interpolation) counts", () => {
        const map = analyze("const x = `hello`;");
        expect(top(map)).toBe(1);
    });

    test("template literal with interpolation counts as one", () => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code under test
        const map = analyze("const x = `hi ${name}`;");
        expect(top(map)).toBe(1);
    });

    test("string method call: toUpperCase", () => {
        const map = analyze(`s.toUpperCase();`);
        expect(top(map)).toBe(1);
    });

    test("string method call: split + trim chained", () => {
        // Top level: split call + "," string literal = 2.
        // Arrow `x => x.trim()`: trim call = 1.
        const map = analyze(`s.split(",").map(x => x.trim());`);
        expect(top(map)).toBe(2);
        const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
        expect(fnIds).toHaveLength(1);
        expect(map.get(fnIds[0])).toBe(1);
    });

    test("optional chaining method call counts", () => {
        // replace, "a", "b" => 3
        const map = analyze(`s?.replace("a", "b");`);
        expect(top(map)).toBe(3);
    });

    test("computed member call with string literal counts", () => {
        // computed call (toUpperCase) + the "toUpperCase" string literal => 2
        const map = analyze(`s["toUpperCase"]();`);
        expect(top(map)).toBe(2);
    });

    test("computed member call with non-string-method literal does not count as call but literal still counts", () => {
        // "push" is just a string literal, not a string method => 1
        const map = analyze(`s["push"]();`);
        expect(top(map)).toBe(1);
    });

    test("computed member call with non-literal does not count", () => {
        const map = analyze(`s[method]();`);
        expect(top(map)).toBeUndefined();
    });

    test("concatenation with string literal counts", () => {
        // binary + and "b" string literal => 2
        const map = analyze(`const x = a + "b";`);
        expect(top(map)).toBe(2);
    });

    test("concatenation with template literal counts", () => {
        // binary + and `b` template literal => 2
        const map = analyze("const x = a + `b`;");
        expect(top(map)).toBe(2);
    });

    test("numeric addition does not count", () => {
        const map = analyze(`const x = 1 + 2;`);
        expect(top(map)).toBeUndefined();
    });

    test("non-string method call does not count (e.g. push)", () => {
        const map = analyze(`arr.push(1);`);
        expect(top(map)).toBeUndefined();
    });

    describe("ambiguous array/string methods do not count", () => {
        // indexOf, includes, slice, concat, lastIndexOf, at, toString
        // are also Array.prototype methods, so they should not be counted.
        test("indexOf", () => {
            const map = analyze(`x.indexOf("a");`);
            expect(top(map)).toBe(1); // just the "a" literal
        });

        test("includes", () => {
            const map = analyze(`x.includes("a");`);
            expect(top(map)).toBe(1);
        });

        test("lastIndexOf", () => {
            const map = analyze(`x.lastIndexOf("a");`);
            expect(top(map)).toBe(1);
        });

        test("slice", () => {
            const map = analyze(`x.slice(0, 1);`);
            expect(top(map)).toBeUndefined();
        });

        test("concat", () => {
            const map = analyze(`x.concat(y);`);
            expect(top(map)).toBeUndefined();
        });

        test("at", () => {
            const map = analyze(`x.at(0);`);
            expect(top(map)).toBeUndefined();
        });

        test("toString", () => {
            const map = analyze(`x.toString();`);
            expect(top(map)).toBeUndefined();
        });
    });

    test("mixed sample", () => {
        const code = `
            const a = "hello";
            const b = a.toUpperCase();
            const c = a + " world";
            const d = \`val=\${a}\`;
            const e = a.split(",").map(s => s.trim());
        `;
        // Top level:
        //   "hello"           => 1
        //   toUpperCase       => 1
        //   +, " world"       => 2
        //   template literal  => 1
        //   split, ","        => 2
        //   total             => 7
        // Arrow `s => s.trim()`:
        //   trim              => 1
        const map = analyze(code);
        expect(top(map)).toBe(7);
        const fnIds = [...map.keys()].filter((k) => k !== topLevelId());
        expect(fnIds).toHaveLength(1);
        expect(map.get(fnIds[0])).toBe(1);
    });
});
