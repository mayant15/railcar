/**
 * Computes cyclomatic complexity for every function in the source.
 *
 * Based on ESLint's complexity rule.
 * https://github.com/eslint/eslint/blob/main/lib/rules/complexity.js
 *
 * This is different from the Wikipedia definition of complexity, but
 * coincides for JavaScript with structured control flow and no goto.
 *
 * JavaScript does have labelled break and continue which breaks this
 * assumption, but for our data set only 79 out of 2211 break and
 * continue statements are labelled. So we choose to ignore those in
 * favor of a simpler analysis.
 */

import assert from "node:assert";
import type { NodePath, PluginTarget } from "@babel/core";
import type {
    AssignmentExpression,
    Function as BabelFunction,
    CallExpression,
    MemberExpression,
    SwitchCase,
} from "@babel/types";
import { getCanonicalFunctionId } from "./function-extract.ts";

const LOGICAL_ASSIGNMENT_OPERATORS = new Set(["&&=", "||=", "??="]);

export class ComplexityAnalysis {
    file: string;
    /** Per-function results. Map from function ID to complexity. */
    map: Map<string, number> = new Map();
    /** Stack of function IDs on the current path. */
    stack: string[] = [];

    constructor(file: string) {
        this.file = file;
    }

    plugin(): PluginTarget {
        // Capture `this` in a closure and use it in the visitor to share state.
        const self = this;
        // Call to `this.inc` with `self` bound to `this`. For passing the function as-is
        // to a Babel visitor.
        const inc = () => self.inc();

        return {
            visitor: {
                Program: {
                    enter() {
                        const id = getCanonicalFunctionId({
                            file: self.file,
                            loc: null,
                        });

                        assert(!self.map.has(id));
                        assert(self.stack.length === 0);

                        self.stack.push(id);
                        self.inc();
                    },
                    exit() {
                        const top = self.stack.pop();
                        assert(top);
                    },
                },
                Function: {
                    enter(path: NodePath<BabelFunction>) {
                        const loc = path.node.loc;
                        assert(loc !== null);
                        assert(loc !== undefined);

                        const id = getCanonicalFunctionId({
                            file: self.file,
                            loc,
                        });

                        assert(!self.map.has(id));
                        self.stack.push(id);
                        self.inc();
                    },
                    exit() {
                        const top = self.stack.pop();
                        assert(top);
                    },
                },

                IfStatement: inc,
                ConditionalExpression: inc,
                LogicalExpression: inc,
                ForStatement: inc,
                ForInStatement: inc,
                ForOfStatement: inc,
                WhileStatement: inc,
                DoWhileStatement: inc,
                CatchClause: inc,
                AssignmentPattern: inc,

                AssignmentExpression(path: NodePath<AssignmentExpression>) {
                    if (LOGICAL_ASSIGNMENT_OPERATORS.has(path.node.operator)) {
                        self.inc();
                    }
                },

                OptionalMemberExpression: inc,
                OptionalCallExpression: inc,
                MemberExpression(path: NodePath<MemberExpression>) {
                    if (path.node.optional) self.inc();
                },
                CallExpression(path: NodePath<CallExpression>) {
                    if (path.node.optional) self.inc();
                },

                SwitchCase(path: NodePath<SwitchCase>) {
                    if (path.node.test) self.inc();
                },
            },
        };
    }

    private inc() {
        assert(this.stack.length > 0);
        const top = this.stack[this.stack.length - 1];

        const current = this.map.get(top) ?? 0;
        this.map.set(top, current + 1);
    }
}
