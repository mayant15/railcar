// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import ts from "typescript";

import type { EndpointName, Schema, TypeGuess } from "./schema.js";
import { addStd, Guess, Types, type StdTypes } from "./common.js";

type Context = {
    functions: ts.FunctionDeclaration[];
    checker: ts.TypeChecker;
    print: (node: ts.Node) => string;
    schema: Schema;
    std: StdTypes;
    derivedClasses: Record<EndpointName, EndpointName[]>;
};

export function deriveFromDeclFile(path: string) {
    const program = ts.createProgram({
        rootNames: [path],
        options: {
            noEmit: true,
        },
    });
    const source = program.getSourceFile(path);
    assert(source !== undefined);

    const printer = ts.createPrinter({
        removeComments: true,
        omitTrailingSemicolon: true,
        newLine: ts.NewLineKind.LineFeed,
    });

    const checker = program.getTypeChecker();

    const schema = {};
    const std = addStd(schema);

    const ctx: Context = {
        functions: [],
        checker,
        print: (node: ts.Node) =>
            printer.printNode(ts.EmitHint.Unspecified, node, source),
        schema,
        std,
        derivedClasses: {},
    };

    const exports = extractExports(ctx, source);

    for (const exp of exports) {
        deriveSymbol(ctx, exp);
    }

    const done = new Set<EndpointName>();
    for (const cls of Object.keys(ctx.derivedClasses)) {
        addParentMethods(ctx, cls, done);
    }

    return ctx.schema;
}

function addParentMethods(
    ctx: Context,
    cls: EndpointName,
    done: Set<EndpointName>,
) {
    assert(cls in ctx.derivedClasses, "cls not in derivedClasses");

    const parents = ctx.derivedClasses[cls];
    for (const parent of parents) {
        assert(parent in ctx.schema, "parent not in schema " + parent);
        if (ctx.schema[parent].callconv === "Constructor") {
            if (parent in ctx.derivedClasses && !done.has(parent)) {
                addParentMethods(ctx, parent, done);
                done.add(parent);
            }

            const methods = getMethods(ctx, parent);
            for (const method of methods) {
                const splits = method.split(`${parent}.`);
                assert(splits.length >= 2);
                const methodNameWithoutPrefix = splits[1];
                ctx.schema[`${cls}.${methodNameWithoutPrefix}`] = {
                    ...ctx.schema[method],
                    args: [
                        Guess.exact(Types.class(cls)),
                        ...ctx.schema[method].args.slice(1),
                    ],
                };
            }
        }
    }
}

function getMethods(ctx: Context, cls: EndpointName): EndpointName[] {
    return Object.entries(ctx.schema)
        .filter(
            ([name, sig]) => name.startsWith(cls) && sig.callconv === "Method",
        )
        .map(([name]) => name);
}

function deriveSymbol(ctx: Context, exp: ts.Symbol) {
    assert(exp.declarations !== undefined);
    assert(exp.declarations.length > 0);

    const isFree = exp.declarations.every(
        (decl) => decl.kind === ts.SyntaxKind.FunctionDeclaration,
    );
    const isClass = exp.declarations.every(
        (decl) => decl.kind === ts.SyntaxKind.ClassDeclaration,
    );
    assert(
        isClass || isFree,
        "exported symbol must be either class or function to be considered in the schema",
    );

    if (isClass) {
        deriveClassDeclaration(ctx, exp);
    } else if (isFree) {
        const id = makeId(exp);
        const { args, ret } = fromOverloads(
            ctx,
            exp.declarations as ts.FunctionDeclaration[],
        );
        ctx.schema[id] = {
            args,
            ret,
            callconv: "Free",
        };
    }
}

function deriveClassDeclaration(ctx: Context, exp: ts.Symbol) {
    assert(exp.flags & ts.SymbolFlags.Class);
    assert(exp.members !== undefined);

    const id = makeId(exp);

    // collect static functions
    const statics =
        exp.exports !== undefined
            ? exp.exports
                  .entries()
                  .filter(([_, sym]) => sym.flags & ts.SymbolFlags.Method)
                  .map(([name, sym]) => [name, sym] as [string, ts.Symbol])
                  .toArray()
            : [];

    for (const [name, sym] of statics) {
        assert(sym.declarations !== undefined);
        const { args, ret } = fromOverloads(
            ctx,
            sym.declarations as ts.FunctionDeclaration[],
        );
        ctx.schema[`${id}.${name}`] = {
            args,
            ret,
            callconv: "Free",
        };
    }

    // collect methods
    let hasConstructor = false;
    for (const [name, sym] of exp.members) {
        if (sym.flags & ts.SymbolFlags.Constructor) {
            assert(sym.declarations !== undefined);
            const { args } = fromOverloads(
                ctx,
                sym.declarations as ts.FunctionDeclaration[],
            );
            ctx.schema[id] = {
                args,
                ret: Guess.exact(Types.class(id)),
                callconv: "Constructor",
            };
            hasConstructor = true;
        } else if (sym.flags & ts.SymbolFlags.Method) {
            assert(sym.declarations !== undefined);
            const { args, ret } = fromOverloads(
                ctx,
                sym.declarations as ts.FunctionDeclaration[],
            );
            ctx.schema[`${id}.${name}`] = {
                args: [Guess.exact(Types.class(id)), ...args],
                ret,
                callconv: "Method",
            };
        }
    }

    // skip making a constructor for classes that only have statics
    if (!hasConstructor && exp.members.size > 0) {
        ctx.schema[id] = {
            args: [],
            ret: Guess.exact(Types.class(id)),
            callconv: "Constructor",
        };
    }

    // record base classes for second pass
    ctx.derivedClasses[id] = getParentClasses(ctx, exp);
}

function getParentClasses(_ctx: Context, sym: ts.Symbol): EndpointName[] {
    assert(sym.flags & ts.SymbolFlags.Class);
    assert(sym.declarations !== undefined && sym.declarations.length > 0);

    const parents: EndpointName[] = [];

    const decl = sym.declarations[0];

    if (ts.isClassDeclaration(decl)) {
        if (decl.heritageClauses) {
            for (const clause of decl.heritageClauses) {
                for (const typeExpr of clause.types) {
                    assert("escapedText" in typeExpr.expression);
                    const name = typeExpr.expression
                        .escapedText as EndpointName;
                    parents.push(name);
                }
            }
        }
    }

    return parents;
}

function extractExports(ctx: Context, source: ts.SourceFile): ts.Symbol[] {
    assert("symbol" in source);
    const sym: ts.Symbol = source.symbol as any;
    assert(sym.getFlags() & ts.SymbolFlags.ValueModule);

    const exports = ctx.checker.getExportsOfModule(sym);

    return exports.filter((exp) => {
        return (
            exp.declarations !== undefined &&
            exp.declarations.length > 0 &&
            (exp.declarations.every(
                (decl) => decl.kind === ts.SyntaxKind.FunctionDeclaration,
            ) ||
                exp.declarations.every(
                    (decl) => decl.kind === ts.SyntaxKind.ClassDeclaration,
                ))
        );
    });
}

function isFunction(type: ts.Type): boolean {
    // intersection of a type with a function is also a function
    if (type.isIntersection()) {
        return type.types.some(isFunction);
    }

    if (type.symbol !== undefined) {
        if (type.symbol.escapedName === "Function") {
            return true;
        }
    }

    return type.getCallSignatures().length !== 0;
}

function fromUnionType(ctx: Context, type: ts.UnionType): TypeGuess {
    function isLiteral(ty: ts.Type) {
        return (
            ty.flags & ts.TypeFlags.StringLiteral ||
            ty.flags & ts.TypeFlags.NumberLiteral ||
            ty.flags & ts.TypeFlags.BooleanLiteral
        );
    }

    const nonLiterals = type.types
        .filter((ty) => !isLiteral(ty) && !isFunction(ty))
        .map((ty) => fromType(ctx, ty));

    const gs = [...nonLiterals];
    if (nonLiterals.length !== type.types.length) {
        if (type.types.some((ty) => ty.flags & ts.TypeFlags.NumberLiteral)) {
            gs.push(Guess.number());
        }
        if (type.types.some((ty) => ty.flags & ts.TypeFlags.StringLiteral)) {
            gs.push(Guess.string());
        }
        if (type.types.some((ty) => ty.flags & ts.TypeFlags.BooleanLiteral)) {
            gs.push(Guess.boolean());
        }
    }

    return Guess.union(...gs);
}

function fromBuiltin(ctx: Context, type: ts.ObjectType): TypeGuess | null {
    const objectType = type as ts.ObjectType;
    if (objectType.symbol === undefined) {
        return null;
    }

    const className = objectType.symbol.escapedName as string;
    for (const [builtinName, builtinType] of Object.entries(ctx.std)) {
        if (builtinName === className) {
            return Guess.exact(builtinType);
        }
    }

    return null;
}

function fromIntersectionType(
    ctx: Context,
    type: ts.IntersectionType,
): TypeGuess {
    const gs = type.types.map((ty) => fromType(ctx, ty));
    return Guess.intersect(...gs);
}

function fromTuple(ctx: Context, tuple: ts.ObjectType): TypeGuess {
    assert("resolvedTypeArguments" in tuple);

    const gs = (tuple.resolvedTypeArguments as ts.Type[]).map((t) =>
        fromType(ctx, t),
    );

    return Guess.array(Guess.union(...gs));
}

function fromType(ctx: Context, ty: ts.Type): TypeGuess {
    const flags = ty.getFlags();

    if (flags & ts.TypeFlags.StringLiteral || flags & ts.TypeFlags.String) {
        return Guess.string();
    }

    if (flags & ts.TypeFlags.NumberLiteral || flags & ts.TypeFlags.Number) {
        return Guess.number();
    }

    if (flags & ts.TypeFlags.BooleanLiteral || flags & ts.TypeFlags.Boolean) {
        return Guess.boolean();
    }

    if (flags & ts.TypeFlags.Void) {
        return Guess.undefined();
    }

    if (flags & ts.TypeFlags.Null) {
        return Guess.null();
    }

    if (flags & ts.TypeFlags.Unknown) {
        return Guess.any();
    }

    // Don't know if there's a reliable flag for this, using intrinsicName
    if (flags & ts.TypeFlags.NonPrimitive) {
        if ("intrinsicName" in ty && ty.intrinsicName === "object") {
            return Guess.object({});
        }
    }

    if (ty.isUnion()) {
        return fromUnionType(ctx, ty);
    }

    if (ty.isIntersection()) {
        return fromIntersectionType(ctx, ty);
    }

    if (flags & ts.TypeFlags.Object) {
        const objectType = ty as ts.ObjectType;
        const builtin = fromBuiltin(ctx, objectType);
        if (builtin) {
            return builtin;
        }

        if (!("symbol" in objectType)) {
            console.log("no symbol", objectType);
        }

        if ("target" in objectType && objectType.target) {
            const target = objectType.target as ts.ObjectType;
            assert(target.flags & ts.TypeFlags.Object);
            assert(target.objectFlags);
            if (target.objectFlags & ts.ObjectFlags.Tuple) {
                return fromTuple(ctx, objectType);
            }
        }

        if (objectType.objectFlags & ts.ObjectFlags.Tuple) {
            return fromTuple(ctx, objectType);
        }

        if (objectType.symbol.escapedName === "Promise") {
            assert("resolvedTypeArguments" in objectType);
            const typeArgs = objectType.resolvedTypeArguments as ts.Type[];
            assert(typeArgs.length > 0);

            return fromType(ctx, typeArgs[0]);
        }

        if (objectType.objectFlags & ts.ObjectFlags.Class) {
            assert(objectType.symbol !== undefined);
            return Guess.exact(Types.class(makeId(objectType.symbol)));
        }

        if ("symbol" in ty && ty.symbol.escapedName === "Array") {
            assert("resolvedTypeArguments" in ty);
            const typeArgs = ty.resolvedTypeArguments as ts.Type[];
            assert(typeArgs.length > 0);

            // treat array of functions as array of undefineds
            if (isFunction(typeArgs[0])) {
                return Guess.array(Guess.undefined());
            }

            return Guess.array(fromType(ctx, typeArgs[0]));
        }

        const props = Object.fromEntries(
            objectType
                .getProperties()
                .map((sym) => {
                    const name = sym.getEscapedName();
                    if ((name as string).startsWith("__@")) {
                        // these are internal properties
                        return null;
                    }

                    const typ = ctx.checker.getTypeOfSymbol(sym);

                    if (isFunction(typ)) {
                        return null;
                    }

                    let guess = fromType(ctx, typ);
                    if (isOptional(sym)) {
                        guess = Guess.union(Guess.undefined(), guess);
                    }

                    return [name, guess];
                })
                .filter((e) => e !== null),
        );

        return Guess.object(props);
    }

    return Guess.any();
}

function isOptional(symbol: ts.Symbol): boolean {
    assert(symbol.declarations !== undefined && symbol.declarations.length > 0);
    const decl = symbol.declarations[0];

    return "questionToken" in decl && !!decl.questionToken;
}

function fromFunctionDeclaration(
    ctx: Context,
    overload: ts.FunctionDeclaration,
): {
    args: TypeGuess[];
    returnType: TypeGuess;
} {
    const args = overload.parameters.map((param) => {
        if (param.type === undefined) {
            return Guess.any();
        }
        const type = ctx.checker.getTypeFromTypeNode(param.type);

        // If this is a parameter that takes only functions, pass nothing
        if (isFunction(type)) {
            return Guess.undefined();
        }

        let guess = fromType(ctx, type);
        if (param.questionToken) {
            // this is optional
            guess = Guess.union(Guess.undefined(), guess);
        }

        return guess;
    });

    const returnType = (() => {
        // assume unannotated functions are void
        if (overload.type === undefined) {
            return Guess.undefined();
        }

        const retTy = ctx.checker.getTypeFromTypeNode(overload.type);

        // if this function returns only a function, assume it to be void
        if (isFunction(retTy)) {
            return Guess.undefined();
        }

        return fromType(ctx, retTy);
    })();

    return {
        args,
        returnType,
    };
}

function makeId(sym: ts.Symbol): EndpointName {
    return sym.getEscapedName() as string;
}

function fromOverloads(
    ctx: Context,
    overloads: ts.FunctionDeclaration[],
): {
    args: TypeGuess[];
    ret: TypeGuess;
} {
    const signatures = overloads.map((decl) =>
        fromFunctionDeclaration(ctx, decl),
    );

    // union of return type for overloads
    const ret = Guess.union(...signatures.map((s) => s.returnType));

    // component-wise union of arguments for overloads
    const args: TypeGuess[] = [];
    const maxArgc = signatures.reduce(
        (max, s) => (s.args.length > max ? s.args.length : max),
        -1,
    );
    for (let i = 0; i < maxArgc; ++i) {
        const arg = Guess.union(
            ...signatures.map((s) => s.args[i] ?? Guess.undefined()),
        );
        args.push(arg);
    }

    return { args, ret };
}
