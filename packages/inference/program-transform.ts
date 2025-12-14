import parser from "@babel/parser";
import { Export } from "@syntest/analysis-javascript";
import { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import _generate from "@babel/generator";
export const generate =
    typeof _generate === "function"
        ? _generate
        : // @ts-ignore
          _generate.default;
import _traverse from "@babel/traverse";
export const traverse =
    typeof _traverse === "function"
        ? _traverse
        : // @ts-ignore
          _traverse.default;
import * as fs from "fs";

export function addLocationReturn(source: string): string {
    // Parse the source string into an AST
    const ast = parser.parse(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"], // add plugins as needed
    });

    traverse(ast, {
        Function(path) {
            const node = path.node;

            if (!node.loc) return;

            const startRow = node.loc.start.line;
            const startCol = node.loc.start.column;
            const endRow = node.loc.end.line;
            const endCol = node.loc.end.column;
            const startInd = node.start ?? -1;
            const endInd = node.end ?? -1;

            const locString = `:${startRow}:${startCol}:::${endRow}:${endCol}:::${startInd}:${endInd}`;
            const assignStmt = t.expressionStatement(
                t.assignmentExpression(
                    "=",
                    t.memberExpression(t.thisExpression(), t.identifier("loc")),
                    t.stringLiteral(locString),
                ),
            );

            if (t.isBlockStatement(node.body)) {
                // Avoid double‑inserting
                const alreadyInserted =
                    node.body.body.length > 0 &&
                    t.isReturnStatement(node.body.body[0]) &&
                    t.isStringLiteral(node.body.body[0].argument) &&
                    node.body.body[0].argument.value.startsWith(":");

                if (!alreadyInserted) {
                    node.body.body.unshift(assignStmt);
                }
            } else {
                // Arrow function with expression body → wrap in block
                node.body = t.blockStatement([assignStmt]);
            }
        },
    });

    // Print the transformed AST back to source code
    const { code } = generate(ast, {
        retainLines: false,
        compact: false,
        concise: false,
        retainFunctionParens: true,
        decoratorsBeforeExport: true,
        jsescOption: { minimal: true },
    });
    return code;
}

function transformDestructuringAssignment(
    path: NodePath<t.VariableDeclaration>,
) {
    const decls = path.node.declarations;

    const destructurings = decls.filter(
        (d): d is t.VariableDeclarator & { id: t.ObjectPattern } =>
            t.isObjectPattern(d.id),
    );

    if (destructurings.length === 0) return;

    const newDecls = [];

    for (const d of destructurings) {
        const rightExpr = d.init;
        if (!rightExpr) continue;

        for (const prop of d.id.properties) {
            // Skip spread/rest: {...rest}
            if (t.isRestElement(prop)) continue;

            // Now we're sure it's an ObjectProperty
            if (!t.isObjectProperty(prop)) continue;

            // key can be Identifier | StringLiteral | NumericLiteral | ...
            if (!t.isIdentifier(prop.key)) continue;

            const keyName = prop.key.name;
            const aliasName = t.isIdentifier(prop.value)
                ? prop.value.name
                : keyName;

            newDecls.push(
                t.variableDeclaration("const", [
                    t.variableDeclarator(
                        t.identifier(aliasName),
                        t.memberExpression(rightExpr, t.identifier(keyName)),
                    ),
                ]),
            );
        }
    }

    // const raw = generate(path.node).code;
    // const blockComment = `* ${raw.replace(/\*\//g, "*\\/")}`;
    // path.addComment("leading", blockComment, false);
    if (newDecls.length == 0) {
        return;
    }
    path.insertAfter(newDecls);
    path.remove();
}

function transformObjectAssignmentInAssignmentExpression(
    path: NodePath<t.AssignmentExpression>,
) {
    const node = path.node;
    if (
        t.isAssignmentExpression(path.node) &&
        t.isObjectExpression(path.node.right) &&
        path.node.right.properties.length > 0
    ) {
        const { left, right } = path.node;
        if (
            t.isMemberExpression(left) ||
            t.isIdentifier(left) ||
            t.isObjectMember(left)
        ) {
            const emptyObjAssign = t.expressionStatement(
                t.assignmentExpression("=", left, t.objectExpression([])),
            );
            const newStatements = [];
            newStatements.push(emptyObjAssign);

            for (const prop of right.properties) {
                if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                    newStatements.push(
                        t.expressionStatement(
                            t.assignmentExpression(
                                "=",
                                t.memberExpression(
                                    left,
                                    t.identifier(prop.key.name),
                                ),
                                prop.value as t.Expression,
                            ),
                        ),
                    );
                }
            }

            path.replaceWithMultiple(newStatements);
        }
    }
}

function transformObjectAssignment(path: NodePath<t.VariableDeclaration>) {
    for (const decl of path.node.declarations) {
        if (t.isObjectExpression(decl.init) && t.isIdentifier(decl.id)) {
            const varName = decl.id.name;
            const newStatements = [];

            for (const prop of decl.init.properties) {
                if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
                    const key = prop.key.name;

                    // Create: <varName>.<key> = <value>;
                    const assignment = t.expressionStatement(
                        t.assignmentExpression(
                            "=",
                            t.memberExpression(
                                t.identifier(varName),
                                t.identifier(key),
                            ),
                            prop.value as t.Expression,
                        ),
                    );
                    newStatements.push(t.noop());
                    newStatements.push(assignment);
                    // make it null so railcar won't flag it
                    // prop.value = t.nullLiteral();
                }
            }

            path.insertAfter(newStatements);
        }
    }
}

export function transform(source: string, output: string | null = null) {
    const ast = parser.parse(source, {
        sourceType: "module",
        plugins: ["jsx"],
    });

    traverse(ast, {
        VariableDeclaration(path: NodePath<t.VariableDeclaration>) {
            transformObjectAssignment(path);
            transformDestructuringAssignment(path);
        },
        AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
            transformObjectAssignmentInAssignmentExpression(path);
        },
    });

    let anonCounter = 0;

    traverse(ast, {
        AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
            const { node } = path;
            if (
                t.isMemberExpression(node.left) &&
                (t.isArrowFunctionExpression(node.right) ||
                    t.isFunctionExpression(node.right))
            ) {
                const fn: t.FunctionExpression | t.ArrowFunctionExpression =
                    node.right;
                if (
                    (t.isFunctionExpression(fn) && !fn.id) ||
                    t.isArrowFunctionExpression(fn)
                ) {
                    const name = `___railcar_anon_func_${anonCounter++}___`;

                    const funcDecl = t.functionDeclaration(
                        t.identifier(name),
                        fn.params,
                        t.isBlockStatement(fn.body)
                            ? fn.body
                            : t.blockStatement([t.returnStatement(fn.body)]),
                        false,
                        fn.async,
                    );
                    try {
                        const statementParent = path.getStatementParent();
                        if (statementParent) {
                            statementParent.insertBefore(funcDecl);
                        } else {
                            path.insertBefore(funcDecl);
                        }
                        path.get("right").replaceWith(t.identifier(name));
                    } catch (e) {
                        console.log({
                            intent: "transform anon functions to named function error",
                            path_code: generate(node).code,
                            new_code: generate(funcDecl).code,
                            err: e,
                        });
                        return 0;
                    }

                    path.get("right").replaceWith(t.identifier(name));
                }
            }
        },
    });

    const { code } = generate(ast, {
        retainLines: false,
        compact: false,
        concise: false,
        retainFunctionParens: true,
        decoratorsBeforeExport: true,
        jsescOption: { minimal: true },
    });
    if (output !== null) {
        try {
            fs.writeFileSync(output, code, "utf8");
        } catch (err) {
            console.error("Error writing file:", err);
        }
    }
    return code;
}
