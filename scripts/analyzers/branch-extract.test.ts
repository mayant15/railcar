/**
 * Tests for the static branch arm extractor in `branch-extract.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e2cb3-9730-7581-92c2-ec126bcac3ef
 * https://ampcode.com/threads/T-019e389b-a1e9-778a-8ef2-b02cc3462c89
 * https://ampcode.com/threads/T-019e8b12-64e2-728e-b664-7ad1cfff1ef3
 * https://ampcode.com/threads/T-019e8b07-b75a-729f-aa93-e5b591fcbd05
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

        test("conditional consequent path is the test expression", () => {
            const arms = extract("const x = a ? b : c;", FILE);
            const consequent = pick(arms, "Conditional", 0);
            expect(consequent.path).toBe("a");
        });

        test("conditional alternate path is the negated test expression", () => {
            const arms = extract("const x = a ? b : c;", FILE);
            const alternate = pick(arms, "Conditional", 1);
            expect(alternate.path).toBe("!a");
        });

        test("logical && right path is the left operand", () => {
            const arms = extract("const x = a && b;", FILE);
            const right = pick(arms, "Logical", 1);
            expect(right.path).toBe("a");
        });

        test("logical || right path is the negated left operand", () => {
            const arms = extract("const x = a || b;", FILE);
            const right = pick(arms, "Logical", 1);
            expect(right.path).toBe("!a");
        });

        test("logical ?? right path is the nullish check on the left operand", () => {
            const arms = extract("const x = a ?? b;", FILE);
            const right = pick(arms, "Logical", 1);
            expect(right.path).toBe("a == null");
        });

        test("logical left arm has no implied predicate", () => {
            const arms = extract("const x = a && b;", FILE);
            const left = pick(arms, "Logical", 0);
            expect(left.path).toBe("true");
        });

        test("while body path is the loop test", () => {
            const arms = extract("while (a) b;", FILE);
            const body = pick(arms, "Loop", 0);
            expect(body.path).toBe("a");
        });

        test("for body path is the loop test", () => {
            const arms = extract("for (let i = 0; i < n; i++) sink(i);", FILE);
            const body = pick(arms, "Loop", 0);
            expect(body.path).toBe("i < n");
        });

        test("for loop with no test has no implied predicate", () => {
            const arms = extract("for (;;) sink();", FILE);
            const body = pick(arms, "Loop", 0);
            expect(body.path).toBe("true");
        });

        test("do/while body has no implied predicate", () => {
            const arms = extract("do { sink(); } while (a);", FILE);
            const body = pick(arms, "Loop", 0);
            expect(body.path).toBe("true");
        });

        test("for-in body has no implied predicate", () => {
            const arms = extract("for (const k in o) sink(k);", FILE);
            const body = pick(arms, "Loop", 0);
            expect(body.path).toBe("true");
        });

        test("for-of body has no implied predicate", () => {
            const arms = extract("for (const k of o) sink(k);", FILE);
            const body = pick(arms, "Loop", 0);
            expect(body.path).toBe("true");
        });

        test("switch case path equates discriminant with case test", () => {
            const arms = extract(
                "switch (x) { case 1: a(); break; case 2: b(); break; }",
                FILE,
            );
            const case0 = pick(arms, "Switch", 0);
            const case1 = pick(arms, "Switch", 1);
            expect(case0.path).toBe("x === 1");
            expect(case1.path).toBe("x === 2");
        });

        test("switch default path negates all labelled case tests", () => {
            const arms = extract(
                "switch (x) { case 1: a(); break; case 2: b(); break; default: c(); }",
                FILE,
            );
            // The default case is the last one in source order.
            const switchArms = arms.filter((a) => a.kind === "Switch");
            const def = switchArms.reduce((a, b) =>
                a.startOffset > b.startOffset ? a : b,
            );
            expect(def.path).toBe("x !== 1 && x !== 2");
        });

        test("switch default with no labelled cases has no implied predicate", () => {
            const arms = extract("switch (x) { default: c(); }", FILE);
            const def = pick(arms, "Switch", 0);
            expect(def.path).toBe("true");
        });

        test("try / catch / finally arms have no implied predicate", () => {
            const arms = extract(
                "try { a(); } catch (e) { b(); } finally { c(); }",
                FILE,
            );
            expect(pick(arms, "Try", 0).path).toBe("true");
            expect(pick(arms, "Try", 1).path).toBe("true");
            expect(pick(arms, "Try", 2).path).toBe("true");
        });

        test("branches inside a function do not see predicates from the enclosing scope", () => {
            // Even though the function is defined inside `if (a)`, calling
            // it can happen anywhere — predicates from the call-site are
            // not statically known, so the inner `if (b)` consequent's
            // path is just `b`, not `a && b`.
            const arms = extract("if (a) { function f() { if (b) c; } }", FILE);
            const ifArms = arms.filter(
                (x) => x.kind === "If" && x.armIndex === 0 && !x.continuation,
            );
            const inner = ifArms.find((x) => x.path !== "a");
            expect(inner?.path).toBe("b");
        });

        test("FnEntry arms have an empty path regardless of enclosing branches", () => {
            const arms = extract("if (a) { function f() {} }", FILE);
            const fnEntries = functionFnEntries(arms);
            expect(fnEntries).toHaveLength(1);
            expect(fnEntries[0].path).toBe("true");
        });

        test("predicates compose across nested branch kinds", () => {
            // Outer if, inner ternary's consequent: should be `a && b`.
            const arms = extract("if (a) { const x = b ? c : d; }", FILE);
            const conseq = pick(arms, "Conditional", 0);
            expect(conseq.path).toBe("a && b");
        });
    });

    // ----- CNF / conjunct normalization ----------------------------------
    //
    // The path string and `numConjuncts` are derived from
    // `computePathCNF`, which (a) flattens top-level `&&`-chains across
    // the stack of enclosing predicates and (b) pushes `!` inward via
    // De Morgan but never collapses `!!x` (which would change JS
    // semantics on non-boolean `x`). It does NOT distribute `||` over
    // `&&` — `(a && b) || c` stays a single opaque conjunct.

    describe.skip("CNF normalization", () => {
        test("compound && test contributes one conjunct per operand", () => {
            const arms = extract("if (a && b) c;", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("a && b");
            expect(consequent.numConjuncts).toBe(2);
        });

        test("deeply nested && flattens into N conjuncts", () => {
            const arms = extract("if (a && b && c && d) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("a && b && c && d");
            expect(consequent.numConjuncts).toBe(4);
        });

        test("nested if predicates accumulate as separate conjuncts", () => {
            const arms = extract("if (a) { if (b) { if (c) sink(); } }", FILE);
            const inner = arms
                .filter((x) => x.kind === "If" && !x.continuation)
                .reduce((a, b) => (a.startOffset > b.startOffset ? a : b));
            expect(inner.path).toBe("a && b && c");
            expect(inner.numConjuncts).toBe(3);
        });

        test("|| stays as a single opaque conjunct (no distribution)", () => {
            const arms = extract("if ((a && b) || c) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("a && b || c");
            expect(consequent.numConjuncts).toBe(1);
        });

        test("!(a && b) becomes a single ||-disjunct", () => {
            const arms = extract("if (!(a && b)) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!a || !b");
            expect(consequent.numConjuncts).toBe(1);
        });

        test("!(a || b) splits into two conjuncts", () => {
            const arms = extract("if (!(a || b)) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!a && !b");
            expect(consequent.numConjuncts).toBe(2);
        });

        test("!(a || b || c) splits into three conjuncts", () => {
            const arms = extract("if (!(a || b || c)) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!a && !b && !c");
            expect(consequent.numConjuncts).toBe(3);
        });

        test("De Morgan recurses through nested mixed && / ||", () => {
            // !(a && (b || c)) → !a || (!b && !c)
            // Generator prints && with tighter precedence than ||, so
            // the inner parens are dropped.
            const arms = extract("if (!(a && (b || c))) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!a || !b && !c");
            expect(consequent.numConjuncts).toBe(1);
        });

        test("!!x is preserved (boolean coercion, not simplified)", () => {
            const arms = extract("if (!!a) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!!a");
            expect(consequent.numConjuncts).toBe(1);
        });

        test("!!(a || b) keeps the outer ! but rewrites the inner !(a || b)", () => {
            // The outer `!` sees `!(a || b)` underneath it, which is a
            // unary, not a `&&`/`||` — so the outer `!` can't be
            // pushed through and stays put (no `!!`-collapsing). But
            // we still recurse into the inner expression, and *that*
            // recursive call sees `!(a || b)` and pushes the inner
            // `!` through De Morgan. Net: `!(!a && !b)` — still one
            // conjunct at the top level.
            const arms = extract("if (!!(a || b)) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!(!a && !b)");
            expect(consequent.numConjuncts).toBe(1);
        });

        test("De Morgan from one predicate composes with conjuncts from another", () => {
            // Outer: `a`. Inner: `!(b || c)` → `!b && !c`.
            // Joined: `a && !b && !c`.
            const arms = extract("if (a) { if (!(b || c)) sink(); }", FILE);
            const inner = arms
                .filter((x) => x.kind === "If" && !x.continuation)
                .reduce((a, b) => (a.startOffset > b.startOffset ? a : b));
            expect(inner.path).toBe("a && !b && !c");
            expect(inner.numConjuncts).toBe(3);
        });

        test("switch default's &&-chain of `!==`s is flattened into conjuncts", () => {
            const arms = extract(
                "switch (x) { case 1: a(); break; case 2: b(); break; case 3: c(); break; default: d(); }",
                FILE,
            );
            const switchArms = arms.filter((a) => a.kind === "Switch");
            const def = switchArms.reduce((a, b) =>
                a.startOffset > b.startOffset ? a : b,
            );
            expect(def.path).toBe("x !== 1 && x !== 2 && x !== 3");
            expect(def.numConjuncts).toBe(3);
        });

        test("?? is treated as an opaque atom (no De Morgan)", () => {
            // We only push `!` through `&&` / `||`, never through
            // `??`. So the consequent predicate `!(a ?? b)` stays a
            // single opaque conjunct rather than being rewritten.
            const arms = extract("if (!(a ?? b)) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.path).toBe("!(a ?? b)");
            expect(consequent.numConjuncts).toBe(1);
        });

        test("duplicate conjuncts are not deduplicated", () => {
            const arms = extract("if (a) { if (a) sink(); }", FILE);
            const inner = arms
                .filter((x) => x.kind === "If" && !x.continuation)
                .reduce((a, b) => (a.startOffset > b.startOffset ? a : b));
            expect(inner.path).toBe("a && a");
            expect(inner.numConjuncts).toBe(2);
        });

        test("empty predicate stack produces zero conjuncts", () => {
            const arms = extract("if (a) b;", FILE);
            const cont = pick(arms, "If", 2);
            expect(cont.path).toBe("true");
            expect(cont.numConjuncts).toBe(0);
        });

        test("numVariables and numConstants count atoms across all conjuncts", () => {
            // Path: `a > 1 && b < 2`. Variables: a, b. Constants: 1, 2.
            const arms = extract("if (a > 1 && b < 2) sink();", FILE);
            const consequent = pick(arms, "If", 0);
            expect(consequent.numConjuncts).toBe(2);
            expect(consequent.numVariables).toBe(2);
            expect(consequent.numConstants).toBe(2);
        });
    });

    // ----- numConstants ---------------------------------------------------
    //
    // `numConstants` counts literal nodes anywhere in the (combined)
    // path expression: numeric, string, boolean, null, regexp, bigint,
    // and template literals. A template literal counts as one constant
    // regardless of how many `${}` interpolations it has — its embedded
    // expressions are counted as variables, not constants.

    describe("numConstants", () => {
        test("counts a single numeric literal", () => {
            const arms = extract("if (x === 5) y;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(1);
        });

        test("counts string, boolean, and null literals", () => {
            const arms = extract(
                'if (a === "x" || b === true || c === null) y;',
                FILE,
            );
            expect(pick(arms, "If", 0).numConstants).toBe(3);
        });

        test("counts a bigint literal", () => {
            const arms = extract("if (x === 5n) y;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(1);
        });

        test("counts a regexp literal", () => {
            const arms = extract("if (/re/.test(s)) y;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(1);
        });

        test("does not count template literals", () => {
            const arms = extract("if (s === `foo`) y;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(0);
        });

        test("template interpolations don't add to the constant count", () => {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: template string is inside the code to be parsed.
            const arms = extract("if (s === `foo${x}bar`) y;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(0);
        });

        test("counts literals used as member indices", () => {
            const arms = extract("if (arr[0]) y;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(1);
        });

        test("is zero when the predicate has only identifiers", () => {
            const arms = extract("if (a && b) c;", FILE);
            expect(pick(arms, "If", 0).numConstants).toBe(0);
        });

        test("sums literals across all conjuncts", () => {
            const arms = extract(
                "if (a > 1 && b < 2 && c === 3) sink();",
                FILE,
            );
            expect(pick(arms, "If", 0).numConstants).toBe(3);
        });
    });

    // ----- numVariables ---------------------------------------------------
    //
    // `numVariables` counts the number of *unique* identifier names
    // referenced in the path expression. Member-expression property
    // names (`obj.foo` → `obj` and `foo`) are counted; object-literal
    // keys (`{ foo: x }` → only `x`) are not.

    describe("numVariables", () => {
        test("counts a single identifier reference", () => {
            const arms = extract("if (a) b;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(1);
        });

        test("counts distinct identifiers across conjuncts", () => {
            const arms = extract("if (a && b && c) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(3);
        });

        test("deduplicates repeated identifier references", () => {
            const arms = extract("if (a > 1 && a < 10) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(1);
        });

        test("counts member-expression property names", () => {
            // Both `obj` and `foo` count.
            const arms = extract("if (obj.foo) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(2);
        });

        test("counts identifiers inside computed member access", () => {
            const arms = extract("if (obj[key]) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(2);
        });

        test("skips object-literal key identifiers", () => {
            // `{foo: x}.foo` — `foo` is counted once (as the member
            // property); its appearance as the object key is skipped.
            // The value `x` is also counted. Net: {x, foo}.
            const arms = extract("if (({foo: x}).foo) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(2);
        });

        test("counts identifiers inside computed object keys", () => {
            // `{[k]: v}.foo` — computed key `k`, value `v`, and member
            // property `foo` all count.
            const arms = extract("if (({[k]: v}).foo) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(3);
        });

        test("counts the operand of typeof", () => {
            const arms = extract('if (typeof x === "string") y;', FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(1);
        });

        test("counts every identifier in a method-call predicate", () => {
            // `Array`, `isArray`, and `x`.
            const arms = extract("if (Array.isArray(x)) y;", FILE);
            expect(pick(arms, "If", 0).numVariables).toBe(3);
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
