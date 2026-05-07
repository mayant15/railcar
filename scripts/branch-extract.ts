/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Static AST pass that enumerates branch arms in a JavaScript source file
 * and emits a canonical ID per arm. IDs are stable across runs and can be
 * joined against V8 block coverage (see v8cov-to-canonical.ts).
 *
 * The arm taxonomy mirrors what V8 instruments under
 * `Profiler.startPreciseCoverage(detailed=true)`. Per the V8 design doc
 * (https://docs.google.com/document/d/1wCydi2HEZRF0skDeLb6CH0abZnTyVo5Vz5u-jhwi7es/),
 * each branching construct has counters for its arms plus a "continuation"
 * counter at the byte right after the construct. The continuation counter
 * only differs from its enclosing function's count when a non-local exit
 * (return/throw/break/continue) inside an arm prevents fall-through.
 *
 *   - If    armIndex 0 = consequent
 *           armIndex 1 = alternate (only when source has an `else`)
 *           armIndex 2 = continuation (always)
 *   - Loop  armIndex 0 = body
 *           armIndex 1 = continuation
 *           Covers For / While / DoWhile / ForIn / ForOf.
 *   - Try   armIndex 0 = try block
 *           armIndex 1 = catch handler body (only if present)
 *           armIndex 2 = finally block (only if present)
 *           armIndex 3 = continuation
 *   - Switch       one arm per `case`/`default`
 *   - Conditional  arm 0 = consequent, arm 1 = alternate
 *   - Logical      arm 0 = left, arm 1 = right
 *   - FnEntry      one arm per function (useful for FN/FNDA joining)
 *
 * Continuation arms are zero-width points anchored at the construct's
 * `end` offset. The joiner matches them by start-offset against the V8
 * range list.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019dfa11-4277-77f3-be17-4125ea8163e4
 */

import assert from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { transformSync, type NodePath, type PluginTarget } from "@babel/core";
import type {
    ConditionalExpression,
    Function as BabelFunction,
    IfStatement,
    LogicalExpression,
    Loop,
    Node,
    SwitchStatement,
    TryStatement,
} from "@babel/types";

export type BranchKind =
    | "If"
    | "Loop"
    | "Try"
    | "Switch"
    | "Conditional"
    | "Logical"
    | "FnEntry";

export type BranchArm = {
    /** 16-char SHA-1 prefix of (file, kind, location, armIndex). Stable. */
    id: string;
    file: string;
    kind: BranchKind;
    /** Per-kind arm slot — see the file-level docstring for the meaning. */
    armIndex: number;
    startLine: number;
    /** 0-indexed, matches Babel/V8 conventions. */
    startCol: number;
    endLine: number;
    endCol: number;
    /** Byte offsets into the source. Used to join against V8 ranges. */
    startOffset: number;
    endOffset: number;
    /**
     * True for the zero-width "continuation" arm anchored at the byte
     * right after the construct ends. The joiner matches these by
     * start-offset rather than by exact (start, end).
     */
    continuation: boolean;
};

export type CanonicalBranchKey = {
    file: string;
    kind: BranchKind;
    startLine: number;
    /** 0-indexed column, matching Babel/V8. */
    startCol: number;
    endLine: number;
    endCol: number;
    armIndex: number;
};

/**
 * Compute the canonical branch ID for a given location. Pure function:
 * the same key always produces the same ID. Use this from the joiner to
 * look up rows produced by `extractBranches` without having to re-run the
 * AST pass.
 */
export function getCanonicalBranchId(key: CanonicalBranchKey): string {
    const s = `${key.file}:${key.kind}:${key.startLine}:${key.startCol}:${key.endLine}:${key.endCol}:${key.armIndex}`;
    return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * Build a canonical key from an AST node. Use this from other Babel-based
 * analyzers (e.g. a branch-depth analyzer) so the rows they emit can be
 * joined back to rows produced by `extractBranches`.
 *
 * Returns `null` when the node lacks location info (e.g. it was
 * synthesized by another transform without a `loc`).
 */
export function getCanonicalBranchKey(
    node: Node,
    opts: { file: string; kind: BranchKind; armIndex: number },
): CanonicalBranchKey | null {
    if (!node.loc) return null;
    const { start, end } = node.loc;
    return {
        file: opts.file,
        kind: opts.kind,
        startLine: start.line,
        startCol: start.column,
        endLine: end.line,
        endCol: end.column,
        armIndex: opts.armIndex,
    };
}

function makeBranchExtractPlugin(
    file: string,
): [() => BranchArm[], () => PluginTarget] {
    const arms: BranchArm[] = [];

    function emit(node: Node, kind: BranchKind, armIndex: number): void {
        if (node.start == null || node.end == null) return;
        const key = getCanonicalBranchKey(node, { file, kind, armIndex });
        if (!key) return;
        arms.push({
            id: getCanonicalBranchId(key),
            ...key,
            startOffset: node.start,
            endOffset: node.end,
            continuation: false,
        });
    }

    /**
     * Emit a zero-width "continuation" arm anchored at the byte right
     * after `anchor` ends. Mirrors V8's continuation counter, which is
     * inserted immediately past every branching construct.
     */
    function emitContinuationAfter(
        anchor: Node,
        kind: BranchKind,
        armIndex: number,
    ): void {
        if (!anchor.loc || anchor.end == null) return;
        const { line, column } = anchor.loc.end;
        const key: CanonicalBranchKey = {
            file,
            kind,
            startLine: line,
            startCol: column,
            endLine: line,
            endCol: column,
            armIndex,
        };
        arms.push({
            id: getCanonicalBranchId(key),
            ...key,
            startOffset: anchor.end,
            endOffset: anchor.end,
            continuation: true,
        });
    }

    return [
        () => arms,
        () => ({
            visitor: {
                IfStatement(path: NodePath<IfStatement>) {
                    emit(path.node.consequent, "If", 0);
                    if (path.node.alternate) {
                        emit(path.node.alternate, "If", 1);
                    }
                    emitContinuationAfter(path.node, "If", 2);
                },
                SwitchStatement(path: NodePath<SwitchStatement>) {
                    path.node.cases.forEach((caseNode, idx) => {
                        emit(caseNode, "Switch", idx);
                    });
                },
                ConditionalExpression(path: NodePath<ConditionalExpression>) {
                    emit(path.node.consequent, "Conditional", 0);
                    emit(path.node.alternate, "Conditional", 1);
                },
                LogicalExpression(path: NodePath<LogicalExpression>) {
                    emit(path.node.left, "Logical", 0);
                    emit(path.node.right, "Logical", 1);
                },
                Loop(path: NodePath<Loop>) {
                    emit(path.node.body, "Loop", 0);
                    emitContinuationAfter(path.node, "Loop", 1);
                },
                TryStatement(path: NodePath<TryStatement>) {
                    emit(path.node.block, "Try", 0);
                    if (path.node.handler) {
                        emit(path.node.handler.body, "Try", 1);
                    }
                    if (path.node.finalizer) {
                        emit(path.node.finalizer, "Try", 2);
                    }
                    emitContinuationAfter(path.node, "Try", 3);
                },
                // eslint-disable-next-line @typescript-eslint/ban-types
                Function(path: NodePath<BabelFunction>) {
                    emit(path.node, "FnEntry", 0);
                },
            },
        }),
    ];
}

/** Extract canonical branch arms from a source string. */
export function extractBranches(code: string, file: string): BranchArm[] {
    const [getArms, plugin] = makeBranchExtractPlugin(file);
    const result = transformSync(code, {
        plugins: [plugin],
        code: false,
        ast: false,
        sourceType: "unambiguous",
        babelrc: false,
        configFile: false,
        filename: file,
    });
    assert(result !== null);
    return getArms();
}

/** Extract canonical branch arms from a file on disk. */
export async function extractBranchesFromFile(
    path: string,
): Promise<BranchArm[]> {
    const code = await readFile(path, "utf-8");
    return extractBranches(code, resolve(path));
}

// ---------------------------------------------------------------------------
// V8 raw coverage → canonical branch rows
// ---------------------------------------------------------------------------

export type V8Range = {
    startOffset: number;
    endOffset: number;
    count: number;
};

export type V8FunctionCoverage = {
    functionName: string;
    isBlockCoverage: boolean;
    ranges: V8Range[];
};

export type V8ScriptCoverage = {
    scriptId?: string;
    url: string;
    functions: V8FunctionCoverage[];
};

export type CanonicalCoverageRow = {
    id: string;
    file: string;
    kind: BranchKind;
    armIndex: number;
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
    /** Hit count from the matched V8 range, or 0 when unmatched. */
    count: number;
    /** True when a V8 range was found for this arm. */
    matched: boolean;
    /** Mirrors `BranchArm.continuation`. */
    continuation: boolean;
    /** Smallest enclosing function name from V8 coverage, if any. */
    functionName: string | null;
};

/**
 * Find the smallest function in the script whose body range fully contains
 * [startOffset, endOffset). V8 records `functionName` per function and the
 * first range of each function is its body.
 */
export function findEnclosingFunctionName(
    startOffset: number,
    endOffset: number,
    scriptCoverage: V8ScriptCoverage,
): string | null {
    let best: string | null = null;
    let bestSize = Number.POSITIVE_INFINITY;
    for (const fn of scriptCoverage.functions) {
        const r0 = fn.ranges[0];
        if (!r0) continue;
        if (r0.startOffset <= startOffset && r0.endOffset >= endOffset) {
            const size = r0.endOffset - r0.startOffset;
            if (size < bestSize) {
                bestSize = size;
                best = fn.functionName || null;
            }
        }
    }
    return best;
}

/**
 * Join V8 raw block coverage to canonical branch arms for a single source.
 *
 * Matching strategy per arm:
 *
 *   - Body arms (non-zero-width):
 *       1. exact `(startOffset, endOffset)` match against a V8 range, or
 *       2. smallest V8 range that fully contains the arm (fall-through to
 *          enclosing function range when V8 didn't emit a sub-range, which
 *          per V8 semantics means `count == enclosing count`).
 *
 *   - Continuation arms (zero-width, anchored at the construct's end):
 *       1. innermost V8 range that *starts* at the arm's offset, or
 *       2. smallest V8 range that contains the offset (= enclosing count,
 *          meaning continuation always happened — no early exit diverged
 *          from the parent's count).
 *
 * Both strategies always produce a count when at least the enclosing
 * function range is present, so `matched` is true in practice for any
 * code that V8 reported on at all.
 */
export function joinC8ToCanonical(
    code: string,
    file: string,
    scriptCoverage: V8ScriptCoverage,
): CanonicalCoverageRow[] {
    const arms = extractBranches(code, file);

    const ranges: V8Range[] = [];
    for (const fn of scriptCoverage.functions) {
        for (const r of fn.ranges) ranges.push(r);
    }

    const exactByKey = new Map<string, V8Range>();
    const byStart = new Map<number, V8Range[]>();
    for (const r of ranges) {
        exactByKey.set(`${r.startOffset}:${r.endOffset}`, r);
        const arr = byStart.get(r.startOffset) ?? [];
        arr.push(r);
        byStart.set(r.startOffset, arr);
    }

    const bySize = [...ranges].sort(
        (a, b) => a.endOffset - a.startOffset - (b.endOffset - b.startOffset),
    );

    // V8 ranges are half-open [start, end). For non-zero-width body arms
    // we treat the arm as half-open too, so equal end offsets nest.
    function smallestContainingBody(
        start: number,
        end: number,
    ): V8Range | null {
        for (const r of bySize) {
            if (r.startOffset <= start && r.endOffset >= end) return r;
        }
        return null;
    }

    // For a zero-width point at offset `x`, [rs, re) contains x iff re > x.
    function smallestContainingPoint(x: number): V8Range | null {
        for (const r of bySize) {
            if (r.startOffset <= x && r.endOffset > x) return r;
        }
        return null;
    }

    function findRange(start: number, end: number): V8Range | null {
        const exact = exactByKey.get(`${start}:${end}`);
        if (exact) return exact;
        return smallestContainingBody(start, end);
    }

    function findContinuationRange(offset: number): V8Range | null {
        const candidates = byStart.get(offset);
        if (candidates && candidates.length > 0) {
            // Innermost (smallest) range starting at this point.
            let best = candidates[0];
            for (const r of candidates) {
                if (
                    r.endOffset - r.startOffset <
                    best.endOffset - best.startOffset
                ) {
                    best = r;
                }
            }
            return best;
        }
        return smallestContainingPoint(offset);
    }

    const rows: CanonicalCoverageRow[] = [];
    for (const arm of arms) {
        const fnName = findEnclosingFunctionName(
            arm.startOffset,
            arm.endOffset,
            scriptCoverage,
        );
        const r = arm.continuation
            ? findContinuationRange(arm.startOffset)
            : findRange(arm.startOffset, arm.endOffset);
        rows.push({
            id: arm.id,
            file: arm.file,
            kind: arm.kind,
            armIndex: arm.armIndex,
            startLine: arm.startLine,
            startCol: arm.startCol,
            endLine: arm.endLine,
            endCol: arm.endCol,
            count: r?.count ?? 0,
            matched: r != null,
            continuation: arm.continuation,
            functionName: fnName,
        });
    }
    return rows;
}

/**
 * Merge multiple V8 ScriptCoverage records for the same URL by summing
 * counts of identical (startOffset, endOffset) ranges. Useful when the
 * same script was loaded by multiple processes/dumps under one run.
 */
export function mergeScriptCoverages(
    scripts: V8ScriptCoverage[],
): V8ScriptCoverage {
    if (scripts.length === 0) {
        throw new Error("mergeScriptCoverages: no scripts");
    }
    const url = scripts[0].url;
    const fnMap = new Map<string, V8FunctionCoverage>();
    for (const s of scripts) {
        for (const fn of s.functions) {
            const r0 = fn.ranges[0];
            const fnKey = r0
                ? `${fn.functionName}:${r0.startOffset}:${r0.endOffset}`
                : `${fn.functionName}:?`;
            const existing = fnMap.get(fnKey);
            if (!existing) {
                fnMap.set(fnKey, {
                    functionName: fn.functionName,
                    isBlockCoverage: fn.isBlockCoverage,
                    ranges: fn.ranges.map((r) => ({ ...r })),
                });
                continue;
            }
            const rmap = new Map<string, V8Range>();
            for (const r of existing.ranges) {
                rmap.set(`${r.startOffset}:${r.endOffset}`, r);
            }
            for (const r of fn.ranges) {
                const k = `${r.startOffset}:${r.endOffset}`;
                const ex = rmap.get(k);
                if (ex) ex.count += r.count;
                else rmap.set(k, { ...r });
            }
            existing.ranges = [...rmap.values()];
        }
    }
    return { url, functions: [...fnMap.values()] };
}

const usage = "usage: bun scripts/branch-extract.ts <file> [file...]";

if (import.meta.main) {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error(usage);
        process.exit(1);
    }

    for (const file of files) {
        const arms = await extractBranchesFromFile(file);
        for (const arm of arms) {
            console.log(JSON.stringify(arm));
        }
    }
}
