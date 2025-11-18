import * as parser from "@babel/parser";
import traverseModule, { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import generatorModule from "@babel/generator";
import * as fs from 'fs';

function transformDestructuringAssignment (path: NodePath<t.VariableDeclaration>) {
  const decls = path.node.declarations;

  const destructurings = decls.filter(
    (d): d is t.VariableDeclarator & { id: t.ObjectPattern } =>
        t.isObjectPattern(d.id)
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
            t.memberExpression(
              rightExpr,
              t.identifier(keyName)
            )
          ),
        ])
      );
    }
  }

  // const raw = generatorModule(path.node).code;
  // const blockComment = `* ${raw.replace(/\*\//g, "*\\/")}`;
  // path.addComment("leading", blockComment, false); 

  path.insertAfter(newDecls);
  path.remove();
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
              t.memberExpression(t.identifier(varName), t.identifier(key)),
              prop.value as t.Expression
            )
          );

          newStatements.push(assignment);
        }
      }

      path.insertAfter(newStatements);
    }
  }
}

export function transform(source: string, output: string|null = null) {
  const ast = parser.parse(source, {
    sourceType: "module",
    plugins: ["jsx"],
  });

  traverseModule(ast, {
    VariableDeclaration(path: NodePath<t.VariableDeclaration>) {
      transformObjectAssignment(path)
      transformDestructuringAssignment(path)
    },
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      if (t.isObjectExpression(path.node.right)) {
        const { left, right } = path.node;

        if (t.isMemberExpression(left)) {
          const newStatements = [];

          for (const prop of right.properties) {
            if (t.isObjectProperty(prop) && t.isIdentifier(prop.key)) {
              newStatements.push(
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.memberExpression(left, t.identifier(prop.key.name)),
                    prop.value as t.Expression
                  )
                )
              );
            }
          }

          // Generate the original assignment code string
          const originalCode = generatorModule(path.parentPath.node).code;

          // Create a block comment: /* obj.a = { x: 1, y: 2 }; */
          const commentedStatement = t.emptyStatement();
          commentedStatement.leadingComments = [
            {
              type: "CommentBlock",
              value: " " + originalCode + " ",
            },
          ];

          if (path.parentPath.isExpressionStatement()) {
            path.parentPath.replaceWithMultiple([
              // commentedStatement,
              ...newStatements,
            ]);
          }
        }
      }
    }
  });

  const { code } = generatorModule(ast, { retainLines: true });
  if (output !== null) {
    try {
      fs.writeFileSync(output, code, "utf8");
    } catch (err) {
      console.error("Error writing file:", err);
    }
  }
  return code;
}
