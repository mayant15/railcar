/**
 * Count the number of "string operations" in given code.
 *
 * A call expression whose callee is a (Optional)MemberExpression with one of these
 * allowed methods (in `STRING_METHODS`) as the property name is a "string operation".
 * Methods that also exist on Array.prototype (e.g. `at`, `concat`, `includes`,`indexOf`)
 * are intentionally excluded to avoid counting array operations as string operations,
 * so this is a conservative estimate.
 *
 * Generated with Amp
 * https://ampcode.com/threads/T-019dffee-44b6-7727-9021-d514f12c6149
 */

import assert from "node:assert";
import type { NodePath } from "@babel/traverse";
import type {
    BinaryExpression,
    CallExpression,
    MemberExpression,
    Node,
    OptionalCallExpression,
    OptionalMemberExpression,
} from "@babel/types";
import * as AST from "@babel/types";
import { FunctionStackAnalysis } from "./function-stack-analysis.ts";

/** Allowed string methods. */
const STRING_METHODS: ReadonlySet<string> = new Set([
    "anchor",
    "big",
    "blink",
    "bold",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "endsWith",
    "fixed",
    "fontcolor",
    "fontsize",
    "italics",
    "link",
    "localeCompare",
    "match",
    "matchAll",
    "normalize",
    "padEnd",
    "padStart",
    "repeat",
    "replace",
    "replaceAll",
    "search",
    "small",
    "split",
    "startsWith",
    "strike",
    "sub",
    "substr",
    "substring",
    "sup",
    "toLocaleLowerCase",
    "toLocaleUpperCase",
    "toLowerCase",
    "toUpperCase",
    "trim",
    "trimEnd",
    "trimLeft",
    "trimRight",
    "trimStart",
]);

function isStringish(node: Node | null | undefined): boolean {
    if (!node) return false;
    return AST.isStringLiteral(node) || AST.isTemplateLiteral(node);
}

function getCalleeName(
    callee: MemberExpression | OptionalMemberExpression,
): string | undefined {
    if (AST.isIdentifier(callee.property)) {
        return callee.property.name;
    }

    if (callee.computed && AST.isStringLiteral(callee.property)) {
        return callee.property.value;
    }
}

export class StringOperationsAnalysis extends FunctionStackAnalysis<number> {
    plugin() {
        const self = this;
        return this.createStackPlugin({
            visitor: {
                // String method calls
                "CallExpression|OptionalCallExpression"(
                    path: NodePath<CallExpression | OptionalCallExpression>,
                ) {
                    const callee = path.node.callee;
                    if (
                        callee.type === "MemberExpression" ||
                        callee.type === "OptionalMemberExpression"
                    ) {
                        const name = getCalleeName(callee);
                        if (name !== undefined && STRING_METHODS.has(name)) {
                            self.inc();
                        }
                    }
                },

                // Template and string literals count by themselves
                TemplateLiteral() {
                    self.inc();
                },
                StringLiteral() {
                    self.inc();
                },

                // String concatenation: `+` with a string-ish operand
                BinaryExpression(path: NodePath<BinaryExpression>) {
                    if (path.node.operator === "+") {
                        if (
                            isStringish(path.node.left) ||
                            isStringish(path.node.right)
                        ) {
                            self.inc();
                        }
                    }
                },
            },
        });
    }

    private inc() {
        assert(this.stack.length > 0);
        const top = this.stack[this.stack.length - 1];

        const count = this.map.get(top) ?? 0;
        this.map.set(top, count + 1);
    }
}
