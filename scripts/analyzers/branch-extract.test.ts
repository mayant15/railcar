/**
 * Tests for the static branch arm extractor in `branch-extract.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e2cb3-9730-7581-92c2-ec126bcac3ef
 * https://ampcode.com/threads/T-019e389b-a1e9-778a-8ef2-b02cc3462c89
 */

import { describe, expect, test } from "bun:test";
import { transformSync } from "@babel/core";
import {
    type BranchArm,
    type BranchKind,
    BranchExtractor,
    getCanonicalBranchId,
} from "./branch-extract.ts";
import { getCanonicalFunctionId } from "./function-extract.ts";

const FILE = "test.ts";

function extract(code: string, file: string): BranchArm[] {
    const brExt = new BranchExtractor(file);
    transformSync(code, {
        plugins: [brExt.plugin()],
        code: false,
        ast: false,
        sourceType: "unambiguous",
        babelrc: false,
        configFile: false,
        filename: file,
    });
    return brExt.arms;
}

/**
 * Project arms down to just `(kind, armIndex, continuation)` for use in
 * exact-equality assertions. `FnEntry` arms (both the whole-file one and
 * any per-function entries) are filtered out here — they're covered by
 * their own test blocks instead, so per-construct tests don't have to
 * repeat them.
 */
function summarize(arms: BranchArm[]): {
    kind: BranchKind;
    armIndex: number;
    continuation: boolean;
}[] {
    return arms
        .filter((a) => a.kind !== "FnEntry")
        .map((a) => ({
            kind: a.kind,
            armIndex: a.armIndex,
            continuation: a.continuation,
        }));
}

function pick(
    arms: BranchArm[],
    kind: BranchKind,
    armIndex: number,
): BranchArm {
    const match = arms.filter(
        (a) => a.kind === kind && a.armIndex === armIndex,
    );
    expect(match).toHaveLength(1);
    return match[0];
}

/**
 * The whole-file `FnEntry` is the one emitted from the `Program` visitor
 * — its `functionId` resolves to the per-file top-level sentinel because
 * there is no enclosing function. Per-function `FnEntry`s reference the
 * function itself.
 */
function isFileFnEntry(a: BranchArm): boolean {
    return (
        a.kind === "FnEntry" &&
        a.functionId === getCanonicalFunctionId({ file: a.file, loc: null })
    );
}

function pickFileFnEntry(arms: BranchArm[]): BranchArm {
    const m = arms.filter(isFileFnEntry);
    expect(m).toHaveLength(1);
    return m[0];
}

function functionFnEntries(arms: BranchArm[]): BranchArm[] {
    return arms.filter((a) => a.kind === "FnEntry" && !isFileFnEntry(a));
}

describe("extract: branches", () => {
    test("empty source still produces a single FnEntry arm", () => {
        const arms = extract("", FILE);
        expect(arms).toHaveLength(1);
        const fileFn = arms[0];
        expect(fileFn.kind).toBe("FnEntry");
        expect(fileFn.armIndex).toBe(0);
        expect(fileFn.continuation).toBe(false);
        expect(fileFn.startOffset).toBe(0);
        expect(fileFn.endOffset).toBe(0);
    });

    test("source with no branching constructs produces only a FnEntry arm", () => {
        const arms = extract("const x = 1; const y = x + 2;", FILE);
        expect(arms).toHaveLength(1);
        expect(arms[0].kind).toBe("FnEntry");
    });

    // ----- file-level FnEntry --------------------------------------------

    describe("file-level FnEntry", () => {
        test("file-level FnEntry arm spans the entire source", () => {
            const code = "function f() { return 1; } const x = 2;";
            const arms = extract(code, FILE);
            const fileFn = pickFileFnEntry(arms);
            expect(fileFn.armIndex).toBe(0);
            expect(fileFn.continuation).toBe(false);
            expect(fileFn.startOffset).toBe(0);
            expect(fileFn.endOffset).toBe(code.length);
        });

        test("file-level FnEntry's functionId matches the top-level sentinel", () => {
            const arms = extract("if (a) b;", FILE);
            const fileFn = pickFileFnEntry(arms);
            expect(fileFn.functionId).toBe(
                getCanonicalFunctionId({ file: FILE, loc: null }),
            );
        });

        test("file-level FnEntry groups with top-level branches but not branches inside functions", () => {
            const arms = extract(
                "if (top) {} function f() { if (inner) {} }",
                FILE,
            );
            const fileFn = pickFileFnEntry(arms);
            const fnEntries = functionFnEntries(arms);
            expect(fnEntries).toHaveLength(1);
            const fnEntry = fnEntries[0];
            const ifs = arms.filter((a) => a.kind === "If");
            const topIfs = ifs.filter(
                (a) => a.functionId === fileFn.functionId,
            );
            const innerIfs = ifs.filter(
                (a) => a.functionId === fnEntry.functionId,
            );
            expect(topIfs.length).toBe(2); // consequent and continuation
            expect(innerIfs.length).toBe(2);
            expect(fileFn.functionId).not.toBe(fnEntry.functionId);
        });

        test("only one file-level FnEntry arm regardless of file content", () => {
            const arms = extract(
                "function f() {} function g() {} if (x) y;",
                FILE,
            );
            expect(arms.filter(isFileFnEntry)).toHaveLength(1);
        });
    });

    // ----- If -------------------------------------------------------------

    describe("If", () => {
        test("if without else emits consequent + continuation only", () => {
            const arms = extract("if (x) y;", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "If", armIndex: 0, continuation: false },
                { kind: "If", armIndex: 2, continuation: true },
            ]);
        });

        test("if/else emits consequent + alternate + continuation", () => {
            const arms = extract("if (x) y; else z;", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "If", armIndex: 0, continuation: false },
                { kind: "If", armIndex: 1, continuation: false },
                { kind: "If", armIndex: 2, continuation: true },
            ]);
        });

        test("continuation arm is zero-width and anchored at if end", () => {
            const code = "if (x) y;";
            const arms = extract(code, FILE);
            const cont = pick(arms, "If", 2);
            expect(cont.continuation).toBe(true);
            expect(cont.startOffset).toBe(code.length);
            expect(cont.endOffset).toBe(code.length);
        });

        test("nested if produces independent arm sets", () => {
            const arms = extract("if (a) { if (b) c; }", FILE);
            // outer If: arm 0 (block), arm 2 (continuation)
            // inner If: arm 0 (c), arm 2 (continuation)
            const ifArms = arms.filter((a) => a.kind === "If");
            expect(ifArms).toHaveLength(4);
            const indices = ifArms.map((a) => a.armIndex).sort();
            expect(indices).toEqual([0, 0, 2, 2]);
        });
    });

    // ----- Loop -----------------------------------------------------------

    describe("Loop", () => {
        test("for loop emits body + continuation", () => {
            const arms = extract("for (let i=0;i<n;i++) body();", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("while loop emits body + continuation", () => {
            const arms = extract("while (x) body();", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("do/while loop emits body + continuation", () => {
            const arms = extract("do body(); while (x);", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("for-in loop emits body + continuation", () => {
            const arms = extract("for (const k in o) body(k);", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("for-of loop emits body + continuation", () => {
            const arms = extract("for (const v of xs) body(v);", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });
    });

    // ----- Try ------------------------------------------------------------

    describe("Try", () => {
        test("try/catch emits try + catch + continuation (no finalizer)", () => {
            const arms = extract("try { a; } catch (e) { b; }", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Try", armIndex: 0, continuation: false },
                { kind: "Try", armIndex: 1, continuation: false },
                { kind: "Try", armIndex: 3, continuation: true },
            ]);
        });

        test("try/finally emits try + finally + continuation (no handler)", () => {
            const arms = extract("try { a; } finally { b; }", FILE);
            expect(summarize(arms)).toEqual([
                { kind: "Try", armIndex: 0, continuation: false },
                { kind: "Try", armIndex: 2, continuation: false },
                { kind: "Try", armIndex: 3, continuation: true },
            ]);
        });

        test("try/catch/finally emits all four arms", () => {
            const arms = extract(
                "try { a; } catch (e) { b; } finally { c; }",
                FILE,
            );
            expect(summarize(arms)).toEqual([
                { kind: "Try", armIndex: 0, continuation: false },
                { kind: "Try", armIndex: 1, continuation: false },
                { kind: "Try", armIndex: 2, continuation: false },
                { kind: "Try", armIndex: 3, continuation: true },
            ]);
        });
    });

    // ----- Switch ---------------------------------------------------------

    describe("Switch", () => {
        test("emits one arm per case", () => {
            const arms = extract(
                "switch (x) { case 1: a(); break; case 2: b(); break; default: c(); }",
                FILE,
            );
            const sw = arms.filter((a) => a.kind === "Switch");
            expect(sw.map((a) => a.armIndex)).toEqual([0, 1, 2]);
            for (const a of sw) expect(a.continuation).toBe(false);
        });

        test("fallthrough empty cases each get their own arm", () => {
            // `case 1:` has empty consequent; `case 2:` carries the body.
            const arms = extract(
                "switch (x) { case 1: case 2: doIt(); break; }",
                FILE,
            );
            const sw = arms.filter((a) => a.kind === "Switch");
            expect(sw).toHaveLength(2);
            expect(sw[0].armIndex).toBe(0);
            expect(sw[1].armIndex).toBe(1);
            // Different start offsets for the two `case` keywords.
            expect(sw[0].startOffset).not.toBe(sw[1].startOffset);
        });
    });

    // ----- Conditional / Logical ------------------------------------------

    describe("Conditional", () => {
        test("ternary emits consequent + alternate", () => {
            const arms = extract("const v = c ? a : b;", FILE);
            const cond = arms.filter((a) => a.kind === "Conditional");
            expect(cond.map((a) => a.armIndex)).toEqual([0, 1]);
            for (const a of cond) expect(a.continuation).toBe(false);
        });
    });

    describe("Logical", () => {
        test("&& emits left + right", () => {
            const arms = extract("const v = a && b;", FILE);
            const lg = arms.filter((a) => a.kind === "Logical");
            expect(lg.map((a) => a.armIndex)).toEqual([0, 1]);
        });

        test("|| emits left + right", () => {
            const arms = extract("const v = a || b;", FILE);
            const lg = arms.filter((a) => a.kind === "Logical");
            expect(lg.map((a) => a.armIndex)).toEqual([0, 1]);
        });

        test("?? emits left + right", () => {
            const arms = extract("const v = a ?? b;", FILE);
            const lg = arms.filter((a) => a.kind === "Logical");
            expect(lg.map((a) => a.armIndex)).toEqual([0, 1]);
        });
    });

    // ----- FnEntry --------------------------------------------------------

    describe("FnEntry", () => {
        test("function declaration emits one function-level FnEntry arm", () => {
            const arms = extract("function f() { return 1; }", FILE);
            const fns = functionFnEntries(arms);
            expect(fns).toHaveLength(1);
            expect(fns[0].armIndex).toBe(0);
        });

        test("arrow function emits FnEntry", () => {
            const arms = extract("const f = () => 1;", FILE);
            expect(functionFnEntries(arms)).toHaveLength(1);
        });

        test("anonymous function expression emits FnEntry", () => {
            const arms = extract("const f = function () { };", FILE);
            expect(functionFnEntries(arms)).toHaveLength(1);
        });

        test("nested functions each emit their own FnEntry", () => {
            const arms = extract(
                "function outer() { function inner() {} }",
                FILE,
            );
            expect(functionFnEntries(arms)).toHaveLength(2);
        });
    });

    // ----- functionId grouping -------------------------------------------

    describe("functionId", () => {
        test("top-level branches share a stable top-level functionId", () => {
            const arms = extract("if (a) b; if (c) d;", FILE);
            const fids = new Set(arms.map((a) => a.functionId));
            expect(fids.size).toBe(1);
            // Matches the canonical top-level sentinel.
            expect([...fids][0]).toBe(
                getCanonicalFunctionId({ file: FILE, loc: null }),
            );
        });

        test("branches inside a function share that function's id", () => {
            const arms = extract("function f() { if (x) y; if (z) w; }", FILE);
            const fns = functionFnEntries(arms);
            expect(fns).toHaveLength(1);
            const fnEntry = fns[0];
            const inFn = arms.filter((a) => a.kind === "If");
            expect(inFn).not.toHaveLength(0);
            for (const a of inFn) {
                expect(a.functionId).toBe(fnEntry.functionId);
            }
        });

        test("FnEntry's functionId references the function itself", () => {
            const arms = extract("function f() { if (x) y; }", FILE);
            const fns = functionFnEntries(arms);
            expect(fns).toHaveLength(1);
            const fnEntry = fns[0];
            expect(fnEntry.functionId).toBe(
                getCanonicalFunctionId({
                    file: FILE,
                    loc: {
                        start: {
                            line: fnEntry.startLine,
                            column: fnEntry.startCol,
                            index: fnEntry.startOffset,
                        },
                        end: {
                            line: fnEntry.endLine,
                            column: fnEntry.endCol,
                            index: fnEntry.endOffset,
                        },
                        // biome-ignore lint/suspicious/noExplicitAny: SourceLocation has more fields we don't need
                    } as any,
                }),
            );
        });

        test("top-level and inner-function branches use different ids", () => {
            const arms = extract(
                "if (top) {} function f() { if (inner) {} }",
                FILE,
            );
            const fns = functionFnEntries(arms);
            expect(fns).toHaveLength(1);
            const fnEntry = fns[0];
            const topIfs = arms.filter(
                (a) => a.kind === "If" && a.functionId !== fnEntry.functionId,
            );
            const innerIfs = arms.filter(
                (a) => a.kind === "If" && a.functionId === fnEntry.functionId,
            );
            expect(topIfs.length).toBeGreaterThan(0);
            expect(innerIfs.length).toBeGreaterThan(0);
            expect(topIfs[0].functionId).not.toBe(innerIfs[0].functionId);
        });

        test("two anonymous functions at different positions get different ids", () => {
            const arms = extract(
                "const a = () => { if(x) y; }; const b = () => { if(z) w; };",
                FILE,
            );
            const fns = functionFnEntries(arms);
            expect(fns).toHaveLength(2);
            expect(fns[0].functionId).not.toBe(fns[1].functionId);
        });

        test("nested function branches use the innermost function's id", () => {
            const arms = extract(
                "function outer() { if (o) {}; function inner() { if (i) {} } }",
                FILE,
            );
            const fns = functionFnEntries(arms);
            expect(fns).toHaveLength(2);
            // Determine which is which by source order.
            const [outerFn, innerFn] =
                fns[0].startOffset < fns[1].startOffset
                    ? [fns[0], fns[1]]
                    : [fns[1], fns[0]];
            const ifs = arms.filter((a) => a.kind === "If" && !a.continuation);
            expect(ifs).toHaveLength(2);
            const ifOuter = ifs.find(
                (a) =>
                    a.startOffset > outerFn.startOffset &&
                    a.startOffset < innerFn.startOffset,
            );
            const ifInner = ifs.find(
                (a) => a.startOffset > innerFn.startOffset,
            );
            expect(ifOuter?.functionId).toBe(outerFn.functionId);
            expect(ifInner?.functionId).toBe(innerFn.functionId);
        });
    });

    // ----- path predicates ------------------------------------------------

    describe("path", () => {
        test("top-level arms have an empty path (true)", () => {
            const arms = extract("const x = 1;", FILE);
            const fileFn = pickFileFnEntry(arms);
            expect(fileFn.path).toBe("true");
        });

        test("if consequent path is the test expression", () => {
            const arms = extract("if (a) b;", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("a");
        });

        test("if alternate path is the negated test expression", () => {
            const arms = extract("if (a) b; else c;", FILE);
            const alternate = pick(arms, "If", 1);
            expect(alternate.path).toBe("!a");
        });

        test("if continuation path returns to the enclosing scope", () => {
            const arms = extract("if (a) b;", FILE);
            const cont = pick(arms, "If", 2);
            expect(cont.path).toBe("true");
        });

        test("nested if consequent conjoins outer and inner predicates", () => {
            const arms = extract("if (a) { if (b) c; }", FILE);
            const ifArms = arms.filter(
                (x) => x.kind === "If" && !x.continuation,
            );
            // Inner consequent is the one whose start offset is greater.
            const [outer, inner] =
                ifArms[0].startOffset < ifArms[1].startOffset
                    ? [ifArms[0], ifArms[1]]
                    : [ifArms[1], ifArms[0]];
            expect(outer.path).toBe("a");
            expect(inner.path).toBe("a && b");
        });

        test("nested if inside else conjoins negation with inner predicate", () => {
            const arms = extract("if (a) x; else { if (b) c; }", FILE);
            const inner = arms.find(
                (x) =>
                    x.kind === "If" &&
                    x.armIndex === 0 &&
                    !x.continuation &&
                    x.path !== "a",
            );
            expect(inner?.path).toBe("!a && b");
        });

        test("uses a compound test expression verbatim", () => {
            const arms = extract("if (a && b) c;", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("a && b");
        });

        test("uses a compound test expression verbatim in nested if", () => {
            const arms = extract("if (a || b) { if (c) {} };", FILE);
            const inner = arms.find(
                (x) =>
                    x.kind === "If" &&
                    x.armIndex === 0 &&
                    !x.continuation &&
                    x.path !== "a || b",
            );
            expect(inner?.path).toBe("(a || b) && c");
        });
    });

    // ----- ID properties --------------------------------------------------

    describe("branch ids", () => {
        test("are stable across runs for the same source", () => {
            const code = "if (a) b; else c;";
            const a = extract(code, FILE).map((x) => x.id);
            const b = extract(code, FILE).map((x) => x.id);
            expect(a).toEqual(b);
        });

        test("are unique across all arms in a non-trivial source", () => {
            const code = `
                function f(x) {
                    if (x > 0) return x; else return -x;
                    for (let i = 0; i < 10; i++) sink(i);
                    try { risky(); } catch (e) { handle(e); } finally { done(); }
                    switch (x) { case 1: case 2: a(); break; default: b(); }
                    const y = x ? a : b;
                    const z = x && (a || c);
                }
                if (top) bottom();
                const g = () => 1;
            `;
            const arms = extract(code, FILE);
            const ids = arms.map((a) => a.id);
            expect(new Set(ids).size).toBe(ids.length);
        });

        test("match getCanonicalBranchId for each emitted arm", () => {
            const code = "if (a) b; else c;";
            const arms = extract(code, FILE);
            for (const a of arms) {
                expect(a.id).toBe(
                    getCanonicalBranchId({
                        file: a.file,
                        kind: a.kind,
                        startLine: a.startLine,
                        startCol: a.startCol,
                        endLine: a.endLine,
                        endCol: a.endCol,
                        armIndex: a.armIndex,
                    }),
                );
            }
        });

        test("differ when the file path changes", () => {
            const code = "if (a) b;";
            const ids1 = extract(code, "a.ts").map((x) => x.id);
            const ids2 = extract(code, "b.ts").map((x) => x.id);
            expect(ids1).not.toEqual(ids2);
        });
    });
});
