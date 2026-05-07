/**
 * Count the number of "string operations" in given code.
 *
 * Generated with Amp
 * https://ampcode.com/threads/T-019dffee-44b6-7727-9021-d514f12c6149
 */

import { readFile } from "node:fs/promises";

import { transform, type PluginTarget } from "@babel/core";
import type { NodePath } from "@babel/traverse";
import type {
    BinaryExpression,
    CallExpression,
    Node,
    OptionalCallExpression,
    StringLiteral,
    TemplateLiteral,
} from "@babel/types";

// Names of String.prototype methods. A call expression whose callee is a
// (Optional)MemberExpression with one of these as the property name is counted
// as a string operation. Methods that also exist on Array.prototype (e.g.
// `at`, `concat`, `includes`, `indexOf`, `lastIndexOf`, `slice`, `toString`)
// are intentionally excluded to avoid counting array operations as string
// operations.
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
    return node.type === "StringLiteral" || node.type === "TemplateLiteral";
}

function makeStringOperationsCountPlugin(): [() => number, () => PluginTarget] {
    let count = 0;
    return [
        () => count,
        () => {
            return {
                visitor: {
                    // (1) String.prototype-style method calls.
                    "CallExpression|OptionalCallExpression"(
                        path: NodePath<CallExpression | OptionalCallExpression>,
                    ) {
                        const callee = path.node.callee;
                        if (
                            callee.type === "MemberExpression" ||
                            callee.type === "OptionalMemberExpression"
                        ) {
                            const name = !callee.computed
                                ? callee.property.type === "Identifier"
                                    ? callee.property.name
                                    : undefined
                                : callee.property.type === "StringLiteral"
                                  ? callee.property.value
                                  : undefined;
                            if (name !== undefined && STRING_METHODS.has(name)) {
                                count++;
                            }
                        }
                    },
                    // (2) Template literals.
                    TemplateLiteral(_path: NodePath<TemplateLiteral>) {
                        count++;
                    },
                    // (2b) String literals.
                    StringLiteral(_path: NodePath<StringLiteral>) {
                        count++;
                    },
                    // (3) String concatenation: `+` with a string-ish operand.
                    BinaryExpression(path: NodePath<BinaryExpression>) {
                        if (
                            path.node.operator === "+" &&
                            (isStringish(path.node.left) ||
                                isStringish(path.node.right))
                        ) {
                            count++;
                        }
                    },
                },
            };
        },
    ];
}

export function countStringOperations(code: string): Promise<number> {
    const [getCount, plugin] = makeStringOperationsCountPlugin();

    return new Promise((res, rej) => {
        transform(code, { plugins: [plugin] }, (err, result) => {
            if (err || !result) return rej(Error("failed to parse"));
            res(getCount());
        });
    });
}

export async function countStringOperationsInFile(
    path: string,
): Promise<number> {
    const code = await readFile(path, "utf-8");
    return countStringOperations(code);
}
