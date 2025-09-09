// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import { expect, describe, test } from "bun:test";

import { codeCoverage } from "./instrument";
import { transformSync } from "@babel/core";
import {
    type IfStatement,
    isIfStatement,
    type BlockStatement,
    isCallExpression,
    isExpressionStatement,
    type ExpressionStatement,
    type CallExpression,
    type Identifier,
    isBlockStatement,
} from "@babel/types";

function expectBlockHasCoverageCall(block: BlockStatement) {
    expect(block.body).toBeArrayOfSize(2);

    const stmt = block.body[0];
    expect(isExpressionStatement(stmt)).toBeTrue();

    const expression = (stmt as ExpressionStatement).expression;
    expect(isCallExpression(expression)).toBeTrue();

    const func = ((expression as CallExpression).callee as Identifier).name;
    expect(func).toBe("global.__railcar__.recordHit");
}

describe("if statements", () => {
    test("both branches", () => {
        const code = `
if (0) {
    0
} else {
    0
}
`;
        const actual = transformSync(code, {
            plugins: [codeCoverage()],
            ast: true,
        })?.ast;

        expect(actual).not.toBeNil();
        assert(actual !== null);
        assert(actual !== undefined);

        const body = actual.program.body;
        expect(body).toBeArrayOfSize(2);

        const ifStmt = body[0] as IfStatement;
        expect(isIfStatement(ifStmt)).toBeTrue();

        expect(isBlockStatement(ifStmt.consequent)).toBeTrue();
        assert(isBlockStatement(ifStmt.consequent));
        expectBlockHasCoverageCall(ifStmt.consequent);

        expect(ifStmt.alternate).not.toBeNil();
        expect(isBlockStatement(ifStmt.alternate)).toBeTrue();
        assert(isBlockStatement(ifStmt.alternate));
        expectBlockHasCoverageCall(ifStmt.alternate);
    });
});
