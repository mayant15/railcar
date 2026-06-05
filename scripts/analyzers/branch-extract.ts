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
 * https://ampcode.com/threads/T-019e8b07-b75a-729f-aa93-e5b591fcbd05
 */

import { createHash } from "node:crypto";
import assert from "node:assert";

import type { NodePath, PluginTarget } from "@babel/core";
import type {
    ConditionalExpression,
    ForStatement,
    Function as BabelFunction,
    IfStatement,
    LogicalExpression,
    Loop,
    Program,
    SwitchStatement,
    TryStatement,
    Expression,
    WhileStatement,
} from "@babel/types";
import * as AST from "@babel/types";
import { generate } from "@babel/generator";
import { getCanonicalFunctionId } from "./function-extract.ts";

/**
 * Whether path constraints are converted to conjunctive normal form (CNF) before analysis.
 */
const USE_CNF_CONVERSION = false;

/**
 * Whether various path statistics (like narrowing score, number of conjuncts etc.)
 * use AST traversal or simpler heuristics over the path string.
 */
const USE_AST_PATH_STATS = false;

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

    functionId: string;
    hasThrow: boolean;
} & BranchPathStats;

export type BranchPathStats = {
    path: string;
    depth: number;
    narrowingScore: number;
    numConjuncts: number;
    numVariables: number;
    numConstants: number;
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

    constructor(file: string) {
        this.file = file;
    }

    plugin(): PluginTarget {
        // Capture `this` in a closure and use it in the visitor to share state.
        const self = this;

        // Visitors only enumerate arms; predicates and the enclosing
        // function are derived from each emit-site's NodePath at emit
        // time (see `computePath`/`computeFunctionId`). That lets every
        // plugin in the pipeline traverse the AST normally — earlier
        // versions called `path.skip()` inside `IfStatement`, which
        // suppressed descent for sibling plugins (e.g. `FunctionExtractor`)
        // and silently dropped any function nested inside an if/else.
        const visitor = {
            Program(path: NodePath<Program>) {
                // One whole-file arm. The `Program` node spans the
                // entire source, so this gives V8's top-level script
                // coverage a canonical row to join against.
                //
                // function-extract mirrors this with a 'TopLevel' function
                // that should be the parent of all top-level branches.
                self.emit(path, "FnEntry", 0);
            },
            IfStatement: {
                enter(path: NodePath<IfStatement>) {
                    self.emit(path.get("consequent"), "If", 0);
                    if (path.node.alternate) {
                        self.emit(path.get("alternate") as NodePath, "If", 1);
                    }
                },
                exit(path: NodePath<IfStatement>) {
                    self.emitContinuationAfter(path, "If", 2);
                },
            },
            SwitchStatement(path: NodePath<SwitchStatement>) {
                const cases = path.get("cases");
                cases.forEach((casePath, idx) => {
                    self.emit(casePath, "Switch", idx);
                });
            },
            ConditionalExpression(path: NodePath<ConditionalExpression>) {
                self.emit(path.get("consequent"), "Conditional", 0);
                self.emit(path.get("alternate"), "Conditional", 1);
            },
            LogicalExpression(path: NodePath<LogicalExpression>) {
                self.emit(path.get("left"), "Logical", 0);
                self.emit(path.get("right"), "Logical", 1);
            },
            Loop: {
                enter(path: NodePath<Loop>) {
                    self.emit(path.get("body") as NodePath, "Loop", 0);
                },
                exit(path: NodePath<Loop>) {
                    self.emitContinuationAfter(path, "Loop", 1);
                },
            },
            TryStatement: {
                enter(path: NodePath<TryStatement>) {
                    self.emit(path.get("block"), "Try", 0);
                    if (path.node.handler) {
                        self.emit(
                            path.get("handler.body") as NodePath,
                            "Try",
                            1,
                        );
                    }
                    if (path.node.finalizer) {
                        self.emit(path.get("finalizer") as NodePath, "Try", 2);
                    }
                },
                exit(path: NodePath<TryStatement>) {
                    self.emitContinuationAfter(path, "Try", 3);
                },
            },
            // eslint-disable-next-line @typescript-eslint/ban-types
            Function(path: NodePath<BabelFunction>) {
                self.emit(path, "FnEntry", 0);
            },
        };

        return { visitor };
    }

    /**
     * Canonical id of the innermost enclosing function (including `path`
     * itself when it points at a function — that makes `FnEntry`'s
     * `functionId` point at its own function, grouping with the rest of
     * that function's branches). `null` loc collapses to the per-file
     * `TopLevel` sentinel.
     */
    private computeFunctionId(path: NodePath): string {
        const fnPath = path.find((p) => p.isFunction());
        return getCanonicalFunctionId({
            file: this.file,
            loc: fnPath?.node.loc ?? null,
        });
    }

    /**
     * Walk up the parent chain from `path` and collect the predicate
     * implied by each enclosing branching construct. Predicates are
     * returned in outer-to-inner order so the resulting `&&`-chain reads
     * naturally.
     *
     * Predicates per construct (mirrors the taxonomy at the top of this
     * file):
     *   - If/Conditional: `test` for consequent, `!test` for alternate.
     *   - Logical: for the right operand, `left` (`&&`), `!left` (`||`),
     *     or `left == null` (`??`). The left operand always runs, so no
     *     predicate is added.
     *   - While/For body: the loop `test` when present. DoWhile, ForIn,
     *     and ForOf bodies have no statically expressible boolean
     *     predicate and are skipped.
     *   - Switch case body: `discriminant === case.test` for a labelled
     *     case, or `discriminant !== c1.test && discriminant !== c2.test
     *     && ...` for `default`.
     *   - Try: no boolean predicate is implied by being inside a try /
     *     catch / finally block, so nothing is added.
     *
     * Traversal stops at the nearest enclosing function (intra-procedural
     * analysis): predicates from a caller's scope are not visible at the
     * point a function is entered.
     */
    private computeBranchPathStats(path: NodePath): BranchPathStats {
        assert(!USE_AST_PATH_STATS);
        assert(!USE_CNF_CONVERSION);

        const predicates = computeBranchPredicates(path);
        const cnf = USE_CNF_CONVERSION
            ? computePathCNF(predicates)
            : predicates;

        if (cnf.length === 0) {
            return {
                path: "true",
                depth: 0,
                narrowingScore: 0,
                numConjuncts: 0,
                numConstants: 0,
                numVariables: 0,
            };
        }

        const expr = cnf.reduce((acc, e) =>
            AST.logicalExpression("&&", acc, e),
        );
        const str = generate(expr, { comments: false }).code;

        return {
            path: str,
            depth: predicates.length,
            narrowingScore: computeTypeNarrowingScore(str),
            numConjuncts: computeNumConjuncts(str),
            numConstants: computeNumConstants(expr),
            numVariables: computeNumVariables(expr),
        };
    }

    private hasThrowPath(path: NodePath): boolean {
        const node = path.node;
        if (AST.isBlockStatement(node)) {
            for (const stmt of node.body.reverse()) {
                if (AST.isThrowStatement(stmt)) {
                    return true;
                }
            }
            return false;
        } else if (AST.isStatement(node)) {
            return AST.isThrowStatement(node);
        }
        return false;
    }

    private emit(path: NodePath, kind: BranchKind, armIndex: number): void {
        const node = path.node;
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
            functionId: this.computeFunctionId(path),
            ...this.computeBranchPathStats(path),
            hasThrow: this.hasThrowPath(path),
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
        anchor: NodePath,
        kind: BranchKind,
        armIndex: number,
    ): void {
        const node = anchor.node;
        if (!node.loc || node.end == null) return;
        const { line, column } = node.loc.end;
        const branch = {
            id: "",
            kind,
            armIndex,
            file: this.file,
            startLine: line,
            startCol: column,
            endLine: line,
            endCol: column,
            startOffset: node.end,
            endOffset: node.end,
            continuation: true,
            // The continuation lives in the same scope as the construct
            // it follows — its enclosing function and predicate stack
            // come from the anchor's parent, not the anchor itself.
            functionId: this.computeFunctionId(anchor.parentPath ?? anchor),
            ...this.computeBranchPathStats(anchor.parentPath ?? anchor),
            hasThrow: this.hasThrowPath(anchor),
        };
        branch.id = getCanonicalBranchId(branch);
        this.arms.push(branch);
    }
}

function computeBranchPredicates(path: NodePath): Expression[] {
    const predicates: Expression[] = [];
    let cur: NodePath = path;
    while (cur.parentPath) {
        // Intra-procedural: don't cross function boundaries.
        if (cur.isFunction()) break;

        const parent = cur.parentPath;
        if (parent.isIfStatement() || parent.isConditionalExpression()) {
            const parentNode = parent.node as
                | IfStatement
                | ConditionalExpression;
            if (cur.node === parentNode.consequent) {
                predicates.unshift(parentNode.test);
            } else if (cur.node === parentNode.alternate) {
                predicates.unshift(AST.unaryExpression("!", parentNode.test));
            }
        } else if (parent.isLogicalExpression()) {
            const parentNode = parent.node as LogicalExpression;
            if (cur.node === parentNode.right) {
                if (parentNode.operator === "&&") {
                    predicates.unshift(parentNode.left);
                } else if (parentNode.operator === "||") {
                    predicates.unshift(
                        AST.unaryExpression("!", parentNode.left),
                    );
                } else if (parentNode.operator === "??") {
                    predicates.unshift(
                        AST.binaryExpression(
                            "==",
                            parentNode.left,
                            AST.nullLiteral(),
                        ),
                    );
                }
            }
        } else if (parent.isWhileStatement() || parent.isForStatement()) {
            const parentNode = parent.node as WhileStatement | ForStatement;
            if (cur.node === parentNode.body && parentNode.test) {
                predicates.unshift(parentNode.test);
            }
        } else if (parent.isSwitchStatement() && cur.isSwitchCase()) {
            const switchStmt = parent.node as SwitchStatement;
            const switchCase = cur.node;
            if (switchCase.test) {
                predicates.unshift(
                    AST.binaryExpression(
                        "===",
                        switchStmt.discriminant,
                        switchCase.test,
                    ),
                );
            } else {
                // default: discriminant matched none of the labelled
                // cases.
                const others: AST.Expression[] = switchStmt.cases
                    .filter((c) => c.test != null)
                    .map((c) =>
                        AST.binaryExpression(
                            "!==",
                            switchStmt.discriminant,
                            c.test as Expression,
                        ),
                    );
                if (others.length > 0) {
                    const combined = others.reduce((acc, e) =>
                        AST.logicalExpression("&&", acc, e),
                    );
                    predicates.unshift(combined);
                }
            }
        }
        cur = parent;
    }
    return predicates;
}

/**
 * Flatten an `&&`-chain of predicates into its list of conjuncts.
 * Before flattening, each predicate is rewritten by pushing `!`
 * inward via De Morgan's laws so that any `!(a && b)` /
 * `!(a || b)` inside it can also contribute separate conjuncts.
 *
 * What this is NOT:
 *   - Not full CNF: `||` is never distributed over `&&`, so
 *     `(a && b) || c` stays as a single opaque conjunct.
 *   - Not a simplifier: duplicate, trivially-true, and trivially-
 *     false conjuncts are kept as-is. `!!x` is left intact —
 *     collapsing it would change JS semantics for non-boolean `x`.
 *   - Only `&&` and `||` are rewritten. `??`, ternaries,
 *     comparisons, calls, etc. are treated as opaque atoms.
 */
function computePathCNF(predicates: Expression[]): Expression[] {
    const conjuncts: Expression[] = [];
    for (const pred of predicates) {
        const normalized = pushNegationsInward(pred);
        flattenAnd(normalized, conjuncts);
    }
    return conjuncts;
}

function computeNumConjuncts(expr: string): number {
    return expr.matchAll(/&&/g).toArray().length;
}

/**
 * Rewrite `!(a && b)` → `!a || !b` and `!(a || b)` → `!a && !b`,
 * recursing into nested `&&` / `||` / `!` nodes. `!!x` is
 * intentionally preserved (boolean coercion). Non-logical
 * expressions are returned unchanged.
 */
function pushNegationsInward(expr: Expression): Expression {
    if (AST.isUnaryExpression(expr) && expr.operator === "!") {
        const inner = expr.argument;
        if (AST.isLogicalExpression(inner) && inner.operator === "&&") {
            return AST.logicalExpression(
                "||",
                pushNegationsInward(AST.unaryExpression("!", inner.left)),
                pushNegationsInward(AST.unaryExpression("!", inner.right)),
            );
        }
        if (AST.isLogicalExpression(inner) && inner.operator === "||") {
            return AST.logicalExpression(
                "&&",
                pushNegationsInward(AST.unaryExpression("!", inner.left)),
                pushNegationsInward(AST.unaryExpression("!", inner.right)),
            );
        }
        // Don't collapse `!!x` — it's JS's idiomatic boolean
        // coercion and removing it would change semantics for
        // non-boolean `x`. Still recurse so any nested `&&` / `||`
        // inside the argument gets normalized.
        return AST.unaryExpression("!", pushNegationsInward(inner));
    }
    if (
        AST.isLogicalExpression(expr) &&
        (expr.operator === "&&" || expr.operator === "||")
    ) {
        return AST.logicalExpression(
            expr.operator,
            pushNegationsInward(expr.left),
            pushNegationsInward(expr.right),
        );
    }
    return expr;
}

/**
 * Append the top-level `&&` conjuncts of `expr` to `out`,
 * flattening both left- and right-associative chains. Anything
 * that isn't a top-level `&&` is appended as a single conjunct.
 */
function flattenAnd(expr: Expression, out: Expression[]): void {
    if (AST.isLogicalExpression(expr) && expr.operator === "&&") {
        flattenAnd(expr.left, out);
        flattenAnd(expr.right, out);
    } else {
        out.push(expr);
    }
}

function computeNumVariables(expr: Expression): number {
    const variables = new Set<string>();
    findVariableReferences(expr, variables);
    return variables.size;
}

function findVariableReferences(expr: Expression, set: Set<string>) {
    // Skip identifiers that appear as the key of a non-computed
    // object property/method (`{ foo: x }` — `foo` is a name, not a
    // binding). Member-expression properties (`obj.foo`) are *not*
    // skipped: we count both `obj` and `foo`.
    AST.traverse(expr, (node, ancestors) => {
        if (!AST.isIdentifier(node)) return;

        const parent = ancestors[ancestors.length - 1];
        if (
            parent &&
            (AST.isObjectProperty(parent.node) ||
                AST.isObjectMethod(parent.node)) &&
            !parent.node.computed &&
            parent.key === "key"
        ) {
            return;
        }

        set.add(node.name);
    });
}

function computeNumConstants(expr: Expression): number {
    let count = 0;
    AST.traverseFast(expr, (node) => {
        if (
            AST.isNumericLiteral(node) ||
            AST.isStringLiteral(node) ||
            AST.isBooleanLiteral(node) ||
            AST.isNullLiteral(node) ||
            AST.isRegExpLiteral(node) ||
            AST.isBigIntLiteral(node)
        ) {
            count++;
        }
    });
    return count;
}

/**
 * Roughly based on TypeScript's narrowing
 * https://www.typescriptlang.org/docs/handbook/2/narrowing.html
 */
function computeTypeNarrowingScore(expr: string) {
    return expr.matchAll(/typeof|instanceof|Array\.isArray| in /g).toArray()
        .length;
}
