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
    CallExpression,
    MemberExpression,
    SwitchCase,
} from "@babel/types";
import { FunctionStackAnalysis } from "./function-stack-analysis.ts";

const LOGICAL_ASSIGNMENT_OPERATORS = new Set(["&&=", "||=", "??="]);

export class ComplexityAnalysis extends FunctionStackAnalysis<number> {
    plugin(): PluginTarget {
        // Capture `this` in a closure and use it in the visitor to share state.
        const self = this;
        // Call to `this.inc` with `self` bound to `this`. For passing the function as-is
        // to a Babel visitor.
        const inc = () => self.inc();

        return this.createStackPlugin({
            visitor: {
                Program: inc,
                Function: inc,
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
                MemberExpression(path: NodePath<MemberExpression>) {
                    if (path.node.optional) self.inc();
                },

                OptionalCallExpression: inc,
                CallExpression(path: NodePath<CallExpression>) {
                    if (path.node.optional) self.inc();
                },

                SwitchCase(path: NodePath<SwitchCase>) {
                    if (path.node.test) self.inc();
                },
            },
        });
    }

    private inc() {
        assert(this.stack.length > 0);
        const top = this.stack[this.stack.length - 1];

        const current = this.map.get(top) ?? 0;
        this.map.set(top, current + 1);
    }
}
