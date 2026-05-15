/**
 * Tests for the static branch arm extractor in `branch-extract.ts`.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019e2cb3-9730-7581-92c2-ec126bcac3ef
 */

import { describe, expect, test } from "bun:test";
import {
    type BranchArm,
    type BranchKind,
    extract,
    type FunctionAttr,
    getCanonicalBranchId,
    getCanonicalFunctionId,
} from "./branch-extract";

const FILE = "test.ts";

/**
 * Project arms down to just `(kind, armIndex, continuation)` for use in
 * exact-equality assertions. The whole-file `Script` arm is filtered out
 * here — it's covered by its own test block instead, so per-construct
 * tests don't have to repeat it.
 */
function summarize(arms: BranchArm[]): {
    kind: BranchKind;
    armIndex: number;
    continuation: boolean;
}[] {
    return arms
        .filter((a) => a.kind !== "Script")
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

describe("extract: branches", () => {
    test("empty source still produces a single Script arm", () => {
        const arms = extract("", FILE).branches;
        expect(arms).toHaveLength(1);
        const script = arms[0];
        expect(script.kind).toBe("Script");
        expect(script.armIndex).toBe(0);
        expect(script.continuation).toBe(false);
        expect(script.startOffset).toBe(0);
        expect(script.endOffset).toBe(0);
    });

    test("source with no branching constructs produces only a Script arm", () => {
        const arms = extract("const x = 1; const y = x + 2;", FILE).branches;
        expect(arms).toHaveLength(1);
        expect(arms[0].kind).toBe("Script");
    });

    // ----- Script ---------------------------------------------------------

    describe("Script", () => {
        test("Script arm spans the entire source", () => {
            const code = "function f() { return 1; } const x = 2;";
            const arms = extract(code, FILE).branches;
            const scripts = arms.filter((a) => a.kind === "Script");
            expect(scripts).toHaveLength(1);
            const script = scripts[0];
            expect(script.armIndex).toBe(0);
            expect(script.continuation).toBe(false);
            expect(script.startOffset).toBe(0);
            expect(script.endOffset).toBe(code.length);
        });

        test("Script arm's functionId matches the top-level sentinel", () => {
            const arms = extract("if (a) b;", FILE).branches;
            const script = pick(arms, "Script", 0);
            expect(script.functionId).toBe(
                getCanonicalFunctionId({ file: FILE, loc: null }),
            );
        });

        test("Script arm groups with top-level branches but not branches inside functions", () => {
            const arms = extract(
                "if (top) {} function f() { if (inner) {} }",
                FILE,
            ).branches;
            const script = pick(arms, "Script", 0);
            const fnEntry = pick(arms, "FnEntry", 0);
            const ifs = arms.filter((a) => a.kind === "If");
            const topIfs = ifs.filter(
                (a) => a.functionId === script.functionId,
            );
            const innerIfs = ifs.filter(
                (a) => a.functionId === fnEntry.functionId,
            );
            expect(topIfs.length).toBe(2); // consequent and continuation
            expect(innerIfs.length).toBe(2);
            expect(script.functionId).not.toBe(fnEntry.functionId);
        });

        test("only one Script arm regardless of file content", () => {
            const arms = extract(
                "function f() {} function g() {} if (x) y;",
                FILE,
            ).branches;
            expect(arms.filter((a) => a.kind === "Script")).toHaveLength(1);
        });
    });

    // ----- If -------------------------------------------------------------

    describe("If", () => {
        test("if without else emits consequent + continuation only", () => {
            const arms = extract("if (x) y;", FILE).branches;
            expect(summarize(arms)).toEqual([
                { kind: "If", armIndex: 0, continuation: false },
                { kind: "If", armIndex: 2, continuation: true },
            ]);
        });

        test("if/else emits consequent + alternate + continuation", () => {
            const arms = extract("if (x) y; else z;", FILE).branches;
            expect(summarize(arms)).toEqual([
                { kind: "If", armIndex: 0, continuation: false },
                { kind: "If", armIndex: 1, continuation: false },
                { kind: "If", armIndex: 2, continuation: true },
            ]);
        });

        test("continuation arm is zero-width and anchored at if end", () => {
            const code = "if (x) y;";
            const arms = extract(code, FILE).branches;
            const cont = pick(arms, "If", 2);
            expect(cont.continuation).toBe(true);
            expect(cont.startOffset).toBe(code.length);
            expect(cont.endOffset).toBe(code.length);
        });

        test("nested if produces independent arm sets", () => {
            const arms = extract("if (a) { if (b) c; }", FILE).branches;
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
            const arms = extract(
                "for (let i=0;i<n;i++) body();",
                FILE,
            ).branches;
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("while loop emits body + continuation", () => {
            const arms = extract("while (x) body();", FILE).branches;
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("do/while loop emits body + continuation", () => {
            const arms = extract("do body(); while (x);", FILE).branches;
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("for-in loop emits body + continuation", () => {
            const arms = extract("for (const k in o) body(k);", FILE).branches;
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });

        test("for-of loop emits body + continuation", () => {
            const arms = extract(
                "for (const v of xs) body(v);",
                FILE,
            ).branches;
            expect(summarize(arms)).toEqual([
                { kind: "Loop", armIndex: 0, continuation: false },
                { kind: "Loop", armIndex: 1, continuation: true },
            ]);
        });
    });

    // ----- Try ------------------------------------------------------------

    describe("Try", () => {
        test("try/catch emits try + catch + continuation (no finalizer)", () => {
            const arms = extract(
                "try { a; } catch (e) { b; }",
                FILE,
            ).branches;
            expect(summarize(arms)).toEqual([
                { kind: "Try", armIndex: 0, continuation: false },
                { kind: "Try", armIndex: 1, continuation: false },
                { kind: "Try", armIndex: 3, continuation: true },
            ]);
        });

        test("try/finally emits try + finally + continuation (no handler)", () => {
            const arms = extract("try { a; } finally { b; }", FILE).branches;
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
            ).branches;
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
            ).branches;
            const sw = arms.filter((a) => a.kind === "Switch");
            expect(sw.map((a) => a.armIndex)).toEqual([0, 1, 2]);
            for (const a of sw) expect(a.continuation).toBe(false);
        });

        test("fallthrough empty cases each get their own arm", () => {
            // `case 1:` has empty consequent; `case 2:` carries the body.
            const arms = extract(
                "switch (x) { case 1: case 2: doIt(); break; }",
                FILE,
            ).branches;
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
            const arms = extract("const v = c ? a : b;", FILE).branches;
            const cond = arms.filter((a) => a.kind === "Conditional");
            expect(cond.map((a) => a.armIndex)).toEqual([0, 1]);
            for (const a of cond) expect(a.continuation).toBe(false);
        });
    });

    describe("Logical", () => {
        test("&& emits left + right", () => {
            const arms = extract("const v = a && b;", FILE).branches;
            const lg = arms.filter((a) => a.kind === "Logical");
            expect(lg.map((a) => a.armIndex)).toEqual([0, 1]);
        });

        test("|| emits left + right", () => {
            const arms = extract("const v = a || b;", FILE).branches;
            const lg = arms.filter((a) => a.kind === "Logical");
            expect(lg.map((a) => a.armIndex)).toEqual([0, 1]);
        });

        test("?? emits left + right", () => {
            const arms = extract("const v = a ?? b;", FILE).branches;
            const lg = arms.filter((a) => a.kind === "Logical");
            expect(lg.map((a) => a.armIndex)).toEqual([0, 1]);
        });
    });

    // ----- FnEntry --------------------------------------------------------

    describe("FnEntry", () => {
        test("function declaration emits one FnEntry arm", () => {
            const arms = extract("function f() { return 1; }", FILE).branches;
            const fns = arms.filter((a) => a.kind === "FnEntry");
            expect(fns).toHaveLength(1);
            expect(fns[0].armIndex).toBe(0);
        });

        test("arrow function emits FnEntry", () => {
            const arms = extract("const f = () => 1;", FILE).branches;
            expect(arms.filter((a) => a.kind === "FnEntry")).toHaveLength(1);
        });

        test("anonymous function expression emits FnEntry", () => {
            const arms = extract("const f = function () { };", FILE).branches;
            expect(arms.filter((a) => a.kind === "FnEntry")).toHaveLength(1);
        });

        test("nested functions each emit their own FnEntry", () => {
            const arms = extract(
                "function outer() { function inner() {} }",
                FILE,
            ).branches;
            expect(arms.filter((a) => a.kind === "FnEntry")).toHaveLength(2);
        });
    });

    // ----- functionId grouping -------------------------------------------

    describe("functionId", () => {
        test("top-level branches share a stable top-level functionId", () => {
            const arms = extract("if (a) b; if (c) d;", FILE).branches;
            const fids = new Set(arms.map((a) => a.functionId));
            expect(fids.size).toBe(1);
            // Matches the canonical top-level sentinel.
            expect([...fids][0]).toBe(
                getCanonicalFunctionId({ file: FILE, loc: null }),
            );
        });

        test("branches inside a function share that function's id", () => {
            const arms = extract(
                "function f() { if (x) y; if (z) w; }",
                FILE,
            ).branches;
            const fnEntry = pick(arms, "FnEntry", 0);
            const inFn = arms.filter((a) => a.kind === "If");
            expect(inFn).not.toHaveLength(0);
            for (const a of inFn) {
                expect(a.functionId).toBe(fnEntry.functionId);
            }
        });

        test("FnEntry's functionId references the function itself", () => {
            const arms = extract("function f() { if (x) y; }", FILE).branches;
            const fnEntry = pick(arms, "FnEntry", 0);
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
            ).branches;
            const fnEntry = pick(arms, "FnEntry", 0);
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
            ).branches;
            const fns = arms.filter((a) => a.kind === "FnEntry");
            expect(fns).toHaveLength(2);
            expect(fns[0].functionId).not.toBe(fns[1].functionId);
        });

        test("nested function branches use the innermost function's id", () => {
            const arms = extract(
                "function outer() { if (o) {}; function inner() { if (i) {} } }",
                FILE,
            ).branches;
            const fns = arms.filter((a) => a.kind === "FnEntry");
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

    // ----- ID properties --------------------------------------------------

    describe("branch ids", () => {
        test("are stable across runs for the same source", () => {
            const code = "if (a) b; else c;";
            const a = extract(code, FILE).branches.map((x) => x.id);
            const b = extract(code, FILE).branches.map((x) => x.id);
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
            const arms = extract(code, FILE).branches;
            const ids = arms.map((a) => a.id);
            expect(new Set(ids).size).toBe(ids.length);
        });

        test("match getCanonicalBranchId for each emitted arm", () => {
            const code = "if (a) b; else c;";
            const arms = extract(code, FILE).branches;
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
            const ids1 = extract(code, "a.ts").branches.map((x) => x.id);
            const ids2 = extract(code, "b.ts").branches.map((x) => x.id);
            expect(ids1).not.toEqual(ids2);
        });
    });
});

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
        const fns = extract("", FILE).functions;
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
        const fns = extract("const x = 1;", FILE).functions;
        const top = pickFn(fns, (f) => f.type === "TopLevel");
        expect(top.id).toBe(
            getCanonicalFunctionId({ file: FILE, loc: null }),
        );
    });

    test("TopLevel row spans the entire source", () => {
        const code = "function f() {} const x = 1;";
        const fns = extract(code, FILE).functions;
        const top = pickFn(fns, (f) => f.type === "TopLevel");
        expect(top.startOffset).toBe(0);
        expect(top.endOffset).toBe(code.length);
    });

    test("library label is propagated onto every row", () => {
        const fns = extract(
            "function f() {} const g = () => 1;",
            FILE,
            "lib-x",
        ).functions;
        for (const f of fns) {
            expect(f.library).toBe("lib-x");
            expect(f.file).toBe(FILE);
        }
    });

    // ----- per-kind extraction -------------------------------------------

    describe("function kinds", () => {
        test("FunctionDeclaration captures name and params", () => {
            const fns = extract(
                "function foo(a, b, c) { return a; }",
                FILE,
            ).functions;
            const foo = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(foo.name).toBe("foo");
            expect(foo.params).toBe(3);
            expect(foo.async).toBe(false);
            expect(foo.generator).toBe(false);
        });

        test("named FunctionExpression captures its name", () => {
            const fns = extract(
                "const f = function bar() {};",
                FILE,
            ).functions;
            const bar = pickFn(fns, (f) => f.type === "FunctionExpression");
            expect(bar.name).toBe("bar");
        });

        test("anonymous FunctionExpression has null name", () => {
            const fns = extract("const f = function () {};", FILE).functions;
            const fe = pickFn(fns, (f) => f.type === "FunctionExpression");
            expect(fe.name).toBeNull();
        });

        test("ArrowFunctionExpression has null name", () => {
            const fns = extract("const f = (x) => x;", FILE).functions;
            const arrow = pickFn(
                fns,
                (f) => f.type === "ArrowFunctionExpression",
            );
            expect(arrow.name).toBeNull();
            expect(arrow.params).toBe(1);
        });

        test("async arrow sets async=true", () => {
            const fns = extract("const f = async (x) => x;", FILE).functions;
            const arrow = pickFn(
                fns,
                (f) => f.type === "ArrowFunctionExpression",
            );
            expect(arrow.async).toBe(true);
            expect(arrow.generator).toBe(false);
        });

        test("generator function sets generator=true", () => {
            const fns = extract(
                "function* gen() { yield 1; }",
                FILE,
            ).functions;
            const gen = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(gen.generator).toBe(true);
            expect(gen.async).toBe(false);
            expect(gen.name).toBe("gen");
        });

        test("async generator sets both flags", () => {
            const fns = extract(
                "async function* gen() { yield 1; }",
                FILE,
            ).functions;
            const gen = pickFn(fns, (f) => f.type === "FunctionDeclaration");
            expect(gen.async).toBe(true);
            expect(gen.generator).toBe(true);
        });

        test("ClassMethod captures method name", () => {
            const fns = extract(
                "class C { method(a, b) { return a; } }",
                FILE,
            ).functions;
            const m = pickFn(fns, (f) => f.type === "ClassMethod");
            expect(m.name).toBe("method");
            expect(m.params).toBe(2);
        });

        test("ClassPrivateMethod prefixes name with #", () => {
            const fns = extract(
                "class C { #priv() { return 1; } }",
                FILE,
            ).functions;
            const m = pickFn(fns, (f) => f.type === "ClassPrivateMethod");
            expect(m.name).toBe("#priv");
        });

        test("ObjectMethod captures key name", () => {
            const fns = extract(
                "const o = { greet(name) { return name; } };",
                FILE,
            ).functions;
            const m = pickFn(fns, (f) => f.type === "ObjectMethod");
            expect(m.name).toBe("greet");
            expect(m.params).toBe(1);
        });

        test("string-keyed method captures the literal value", () => {
            const fns = extract(
                "const o = { 'with space'() {} };",
                FILE,
            ).functions;
            const m = pickFn(fns, (f) => f.type === "ObjectMethod");
            expect(m.name).toBe("with space");
        });

        test("computed-key method falls back to null", () => {
            const fns = extract(
                "const k = 'x'; const o = { [k]() {} };",
                FILE,
            ).functions;
            const m = pickFn(fns, (f) => f.type === "ObjectMethod");
            expect(m.name).toBeNull();
        });

        test("rest and default params each count once", () => {
            const fns = extract(
                "function f(a, b = 1, ...rest) {}",
                FILE,
            ).functions;
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
            ).functions;
            const decls = fns.filter(
                (f) => f.type === "FunctionDeclaration",
            );
            expect(decls).toHaveLength(2);
            expect(decls.map((f) => f.name).sort()).toEqual([
                "inner",
                "outer",
            ]);
        });

        test("function ids are unique across all rows", () => {
            const code = `
                function f(x) { if (x) return 1; }
                const g = () => 2;
                class C { method() {} #priv() {} }
                const o = { m() {} };
            `;
            const fns = extract(code, FILE).functions;
            const ids = fns.map((f) => f.id);
            expect(new Set(ids).size).toBe(ids.length);
        });
    });

    // ----- ID properties --------------------------------------------------

    describe("function ids", () => {
        test("are stable across runs for the same source", () => {
            const code = "function f() {} const g = () => 1;";
            const a = extract(code, FILE).functions.map((x) => x.id);
            const b = extract(code, FILE).functions.map((x) => x.id);
            expect(a).toEqual(b);
        });

        test("differ when the file path changes", () => {
            const code = "function f() {}";
            const ids1 = extract(code, "a.ts").functions.map((x) => x.id);
            const ids2 = extract(code, "b.ts").functions.map((x) => x.id);
            expect(ids1).not.toEqual(ids2);
        });

        test("match getCanonicalFunctionId for each emitted row", () => {
            const code =
                "function f() {} const g = () => 1; class C { m() {} }";
            const fns = extract(code, FILE).functions;
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

describe("extract: branch ↔ function joins", () => {
    test("returns both branches and functions in one call", () => {
        const code = "function f() { if (x) y; }";
        const { branches, functions } = extract(code, FILE);
        expect(branches.length).toBeGreaterThan(0);
        expect(functions.length).toBeGreaterThan(0);
    });

    test("every branch.functionId has a matching function row", () => {
        const code = `
            if (top) bottom();
            function f(x) { if (x) return; }
            const g = async () => 1;
            class C { m() { for (const v of []) v; } #p() {} }
            const o = { greet() {} };
        `;
        const { branches, functions } = extract(code, FILE);
        const fnIds = new Set(functions.map((f) => f.id));
        const branchFnIds = new Set(branches.map((b) => b.functionId));
        for (const id of branchFnIds) {
            expect(fnIds.has(id)).toBe(true);
        }
    });

    test("FnEntry arm id matches its function row id", () => {
        const code = "function f() { if (x) y; }";
        const { branches, functions } = extract(code, FILE);
        const fnEntry = branches.find((b) => b.kind === "FnEntry");
        const fnRow = functions.find(
            (f) => f.type === "FunctionDeclaration",
        );
        expect(fnEntry).toBeDefined();
        expect(fnRow).toBeDefined();
        expect(fnEntry?.functionId).toBe(fnRow?.id);
    });

    test("script-scope branches map to the TopLevel row", () => {
        const code = "if (top) bottom();";
        const { branches, functions } = extract(code, FILE);
        const top = pickFn(functions, (f) => f.type === "TopLevel");
        const ifs = branches.filter((b) => b.kind === "If");
        expect(ifs.length).toBeGreaterThan(0);
        for (const arm of ifs) {
            expect(arm.functionId).toBe(top.id);
        }
    });
});
