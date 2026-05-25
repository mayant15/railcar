/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Static AST pass that enumerates branch arms in a JavaScript source file
 * and emits a canonical ID per arm.
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
 * https://ampcode.com/threads/T-019e2cb3-9730-7581-92c2-ec126bcac3ef
 * https://ampcode.com/threads/T-019e2daf-7c8b-722d-80b6-a9e00dcbc115
 */

import { createHash } from "node:crypto";

import type { NodePath, PluginTarget } from "@babel/core";
import type {
    ConditionalExpression,
    Function as BabelFunction,
    IfStatement,
    LogicalExpression,
    Loop,
    Node,
    Program,
    SwitchStatement,
    TryStatement,
    Expression,
} from "@babel/types";
import * as AST from "@babel/types";
import { generate } from "@babel/generator";
import { getCanonicalFunctionId } from "./function-extract.ts";

export type BranchKind =
    | "If"
    | "Loop"
    | "Try"
    | "Switch"
    | "Conditional"
    | "Logical"
    | "FnEntry"
    /**
     * Single arm spanning the entire source file. V8 reports the
     * top-level script as if it were a function (with empty name), so we
     * mirror that here: every file gets exactly one `Script` arm whose
     * `functionId` matches the top-level sentinel used by branches at
     * script scope.
     */
    | "Script";

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

    functionId: string;
    path: string;
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

export class BranchExtractor {
    file: string;
    arms: BranchArm[] = [];

    /**
     * Stack of currently-enclosing functions. Top of stack is the
     * immediate parent function for any branch emitted right now; an
     * empty stack means the branch is at the top level of the script.
     */
    fnStack: BabelFunction[] = [];

    /** Stack of current path predicates. */
    path: Expression[] = [];

    constructor(file: string) {
        this.file = file;
    }

    plugin(): PluginTarget {
        // Capture `this` in a closure and use it in the visitor to share state.
        const self = this;

        const visitor = {
            Program(path: NodePath<Program>) {
                // One whole-file arm. The `Program` node spans the
                // entire source, so this gives V8's top-level script
                // coverage a canonical row to join against.
                //
                // function-extract mirrors this with a 'TopLevel' function
                // that should be the parent of all top-level branches.
                self.emit(path.node, "Script", 0);
            },
            IfStatement(path: NodePath<IfStatement>) {
                const test = path.node.test;

                // Visit the test expression first; the predicate it
                // produces is not yet on the path stack while it runs.
                path.get("test").traverse(visitor);

                self.path.push(test);
                self.emit(path.node.consequent, "If", 0);
                path.get("consequent").traverse(visitor);
                self.path.pop();

                if (path.node.alternate) {
                    self.path.push(AST.unaryExpression("!", test));
                    self.emit(path.node.alternate, "If", 1);
                    path.get("alternate").traverse(visitor);
                    self.path.pop();
                }

                self.emitContinuationAfter(path.node, "If", 2);

                // Children have been traversed manually above with the
                // correct predicates pushed; skip Babel's auto-descent
                // so we don't visit them twice.
                path.skip();
            },
            SwitchStatement(path: NodePath<SwitchStatement>) {
                path.node.cases.forEach((caseNode, idx) => {
                    self.emit(caseNode, "Switch", idx);
                });
            },
            ConditionalExpression(path: NodePath<ConditionalExpression>) {
                self.emit(path.node.consequent, "Conditional", 0);
                self.emit(path.node.alternate, "Conditional", 1);
            },
            LogicalExpression(path: NodePath<LogicalExpression>) {
                self.emit(path.node.left, "Logical", 0);
                self.emit(path.node.right, "Logical", 1);
            },
            Loop(path: NodePath<Loop>) {
                self.emit(path.node.body, "Loop", 0);
                self.emitContinuationAfter(path.node, "Loop", 1);
            },
            TryStatement(path: NodePath<TryStatement>) {
                self.emit(path.node.block, "Try", 0);
                if (path.node.handler) {
                    self.emit(path.node.handler.body, "Try", 1);
                }
                if (path.node.finalizer) {
                    self.emit(path.node.finalizer, "Try", 2);
                }
                self.emitContinuationAfter(path.node, "Try", 3);
            },
            // eslint-disable-next-line @typescript-eslint/ban-types
            Function: {
                enter(path: NodePath<BabelFunction>) {
                    // Push BEFORE emitting so that the FnEntry arm's
                    // functionId points at this function (not its
                    // enclosing one). This makes the FnEntry arm
                    // group with the rest of the function's branches.
                    self.fnStack.push(path.node);
                    self.emit(path.node, "FnEntry", 0);
                },
                exit(_: NodePath<BabelFunction>) {
                    self.fnStack.pop();
                },
            },
        };

        return { visitor };
    }

    private currentFunctionId(): string {
        const fn =
            this.fnStack.length > 0
                ? this.fnStack[this.fnStack.length - 1]
                : null;
        return getCanonicalFunctionId({
            file: this.file,
            loc: fn?.loc ?? null,
        });
    }

    private currentPath(): string {
        if (this.path.length === 0) return "true";
        const expr = this.path.reduce((acc, e) =>
            AST.logicalExpression("&&", acc, e),
        );
        return generate(expr, {
            comments: false,
        }).code;
    }

    private emit(node: Node, kind: BranchKind, armIndex: number): void {
        if (node.start == null || node.end == null || !node.loc) return;
        const branch = {
            id: "",
            kind,
            armIndex,
            file: this.file,
            startLine: node.loc.start.line,
            startCol: node.loc.start.column,
            endLine: node.loc.end.line,
            endCol: node.loc.end.column,
            startOffset: node.start,
            endOffset: node.end,
            continuation: false,
            functionId: this.currentFunctionId(),
            path: this.currentPath(),
        };
        branch.id = getCanonicalBranchId(branch);
        this.arms.push(branch);
    }

    /**
     * Emit a zero-width "continuation" arm anchored at the byte right
     * after `anchor` ends. Mirrors V8's continuation counter, which is
     * inserted immediately past every branching construct.
     */
    private emitContinuationAfter(
        anchor: Node,
        kind: BranchKind,
        armIndex: number,
    ): void {
        if (!anchor.loc || anchor.end == null) return;
        const { line, column } = anchor.loc.end;
        const branch = {
            id: "",
            kind,
            armIndex,
            file: this.file,
            startLine: line,
            startCol: column,
            endLine: line,
            endCol: column,
            startOffset: anchor.end,
            endOffset: anchor.end,
            continuation: true,
            functionId: this.currentFunctionId(),
            path: this.currentPath(),
        };
        branch.id = getCanonicalBranchId(branch);
        this.arms.push(branch);
    }
}
