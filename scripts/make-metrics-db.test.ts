/**
 * Tests for the combined `extract()` pipeline in `make-metrics-db.ts`.
 *
 * The pipeline runs `FunctionExtractor`, `BranchExtractor`, and the various
 * per-function analyses together. These tests pin down the cross-plugin
 * invariants — most importantly, that every `branches.function_id` has a
 * matching row in `functions`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e6d21-49e5-709f-adf2-305f912edb42
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extract } from "./make-metrics-db.ts";

const FILE = "test.ts";

describe("test has throw function", () => {
    test("if throw no block", () => {
        const code = `function foo() {
            if (true) {
                if (2 > 1) 
                    throw new Error(" 2 > 1 "); 
                if (3 > 2) {
                    if (4 > 3) {
                        throw new Error ("in block");
                    }
                    throw new Error ("in If");
                }
            }
        }`
        const { branches } = extract(code, FILE, "test-lib")
        for (const b of branches) {
            if (b.kind === "If") {
                if (b.startLine == 2 && b.endLine == 11) {
                    assert.equal(b.hasThrow, false);
                } else if (b.continuation == false) {
                    assert.equal(b.hasThrow, true);
                } else {
                    assert.equal(b.hasThrow, false);
                }
            }
        }
    })
})

describe("extract: branch.function_id integrity", () => {
    test("every branch's function_id resolves to a function row", () => {
        // Arrow function nested inside an `if` consequent. This used to
        // be invisible to `FunctionExtractor` because `BranchExtractor`'s
        // `IfStatement` handler called `path.skip()`, which suppresses
        // descent for every plugin sharing the traversal.
        const code = `
            class C {
                toString() {
                    let res = '';
                    if (this.classNames) {
                        this.classNames.forEach((klass) => (res += klass));
                    }
                    return res;
                }
            }
        `;

        const { branches, functions } = extract(code, FILE, "test-lib");
        const fnIds = new Set(functions.map((f) => f.id));
        const orphans = branches.filter((b) => !fnIds.has(b.functionId));
        assert.deepEqual(orphans, []);
    });

    test("functions inside if/else branches are extracted", () => {
        const code = `
            function outer() {
                if (cond) {
                    const a = () => 1;
                } else {
                    const b = function named() { return 2; };
                }
            }
        `;

        const { functions } = extract(code, FILE, "test-lib");
        const names = functions.map((f) => f.name);
        assert.ok(
            names.includes("outer"),
            `expected 'outer' in ${JSON.stringify(names)}`,
        );
        assert.ok(
            names.includes("named"),
            `expected 'named' in ${JSON.stringify(names)}`,
        );
        // The arrow has no name but should still appear as an
        // ArrowFunctionExpression row.
        assert.ok(
            functions.some((f) => f.type === "ArrowFunctionExpression"),
            "expected an ArrowFunctionExpression row",
        );
    });
});
