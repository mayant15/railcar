/**
 * V8 raw coverage to canonical branch rows.
 * Split-off from analyzers/branch-extract.ts
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019dfa11-4277-77f3-be17-4125ea8163e4
 * https://ampcode.com/threads/T-019e2cb3-9730-7581-92c2-ec126bcac3ef
 * https://ampcode.com/threads/T-019e2daf-7c8b-722d-80b6-a9e00dcbc115
 */

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
    /**
     * Canonical ID of the enclosing function (or top-level sentinel when
     * the arm is at script scope). Mirrors `BranchArm.functionId` and
     * matches the `id` of that function's `FnEntry` arm.
     */
    functionId: string;
};

/**
 * Find the smallest function in the script whose body range fully contains
 * [startOffset, endOffset). V8 records `functionName` per function and the
 * first range of each function is its body.
 */
function findEnclosingFunctionName(
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
    library: string,
    scriptCoverage: V8ScriptCoverage,
): CanonicalCoverageRow[] {
    const arms = extract(code, file, library).branches;

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
            functionId: arm.functionId,
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
