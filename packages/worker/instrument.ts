/*
 * Copyright 2023 Code Intelligence GmbH
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This file has been derived from jazzer.js/packages/instrumentor/plugins/codeCoverage.ts
 *
 * https://github.com/CodeIntelligenceTesting/jazzer.js/blob/592be5c6d7f453e96822be41fe3f2a1351b8fd96/packages/instrumentor/plugins/codeCoverage.ts
 */

import { type NodePath, type PluginTarget, types } from "@babel/core";
import {
    type BlockStatement,
    type ConditionalExpression,
    type Expression,
    type ExpressionStatement,
    type Function as BabelFunction,
    type IfStatement,
    isBlockStatement,
    isLogicalExpression,
    type LogicalExpression,
    type Loop,
    type Statement,
    type SwitchStatement,
    type TryStatement,
} from "@babel/types";

export function codeCoverage(): () => PluginTarget {
    let nextEdgeId = 0;

    function addCounterToStmt(stmt: Statement): BlockStatement {
        const counterStmt = makeCounterIncStmt();
        if (isBlockStatement(stmt)) {
            const br = stmt as BlockStatement;
            br.body.unshift(counterStmt);
            return br;
        }
        return types.blockStatement([counterStmt, stmt]);
    }

    function makeCounterIncStmt(): ExpressionStatement {
        return types.expressionStatement(makeCounterIncExpr());
    }

    function makeCounterIncExpr(): Expression {
        return types.callExpression(
            types.identifier("global.__railcar__.recordHit"),
            [types.numericLiteral(nextEdgeId++)],
        );
    }

    return () => {
        return {
            visitor: {
                // eslint-disable-next-line @typescript-eslint/ban-types
                Function(path: NodePath<BabelFunction>) {
                    if (isBlockStatement(path.node.body)) {
                        const bodyStmt = path.node.body as BlockStatement;
                        if (bodyStmt) {
                            bodyStmt.body.unshift(makeCounterIncStmt());
                        }
                    } else {
                        // single expression arrow function
                        path.node.body = addCounterToStmt(
                            types.blockStatement([
                                types.returnStatement(path.node.body),
                            ]),
                        );
                    }
                },
                IfStatement(path: NodePath<IfStatement>) {
                    path.node.consequent = addCounterToStmt(
                        path.node.consequent,
                    );
                    if (!path.node.alternate) {
                        path.node.alternate = types.blockStatement([]);
                    }
                    path.node.alternate = addCounterToStmt(path.node.alternate);
                    path.insertAfter(makeCounterIncStmt());
                },
                SwitchStatement(path: NodePath<SwitchStatement>) {
                    for (const caseStmt of path.node.cases) {
                        caseStmt.consequent.unshift(makeCounterIncStmt());
                    }
                    path.insertAfter(makeCounterIncStmt());
                },
                Loop(path: NodePath<Loop>) {
                    path.node.body = addCounterToStmt(path.node.body);
                    path.insertAfter(makeCounterIncStmt());
                },
                TryStatement(path: NodePath<TryStatement>) {
                    // try
                    path.node.block.body.unshift(makeCounterIncStmt());

                    // catch
                    if (path.node.handler) {
                        path.node.handler.body.body.unshift(
                            makeCounterIncStmt(),
                        );
                    }

                    // finally
                    if (path.node.finalizer) {
                        path.node.finalizer.body.unshift(makeCounterIncStmt());
                    }

                    path.insertAfter(makeCounterIncStmt());
                },
                LogicalExpression(path: NodePath<LogicalExpression>) {
                    if (!isLogicalExpression(path.node.left)) {
                        path.node.left = types.sequenceExpression([
                            makeCounterIncExpr(),
                            path.node.left,
                        ]);
                    }
                    if (!isLogicalExpression(path.node.right)) {
                        path.node.right = types.sequenceExpression([
                            makeCounterIncExpr(),
                            path.node.right,
                        ]);
                    }
                },
                ConditionalExpression(path: NodePath<ConditionalExpression>) {
                    path.node.consequent = types.sequenceExpression([
                        makeCounterIncExpr(),
                        path.node.consequent,
                    ]);
                    path.node.alternate = types.sequenceExpression([
                        makeCounterIncExpr(),
                        path.node.alternate,
                    ]);
                    if (isBlockStatement(path.parent)) {
                        path.insertAfter(makeCounterIncStmt());
                    }
                },
            },
        };
    };
}
