/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Derive a Railcar schema from a given TypeScript declaration (.d.ts) file.
 *
 * Main heuristics:
 * 1. mergeUnionBooleans
 * 2. Tuples are arrays with unions for values
 * 3. A `Promise<T>` return is just `T`
 */

import assert from "node:assert"

import ts from "typescript"

import { SignatureGuess, type TypeGuess, type Schema, type CallConvention } from "./schema.js";
import { addStd, Guess } from "./common.js";

/**
 * Produce a schema from a TypeScript declaration file.
 */
export function fromFile(path: string): Schema {
    const ctx = createContext(path)
    const exports = getExportedSymbols(ctx)

    for (const exp of exports) {
        infer(ctx, exp)
    }

    addStd(ctx.schema)
    return ctx.schema
}

type Context = {
    checker: ts.TypeChecker
    sourceFile: ts.SourceFile
    schema: Schema
}

function createContext(path: string) {
    const program = ts.createProgram({
        rootNames: [path],
        options: {
            noEmit: true
        }
    })

    const sourceFile = program.getSourceFile(path)
    assert(sourceFile !== undefined)

    const checker = program.getTypeChecker()

    return { checker, sourceFile, schema: {} }
}

/**
 * Gets all symbols that will eventually become entries in the schema
 */
function getExportedSymbols(ctx: Context): ts.Symbol[] {
    const mod = getMainModule(ctx)
    return ctx.checker.getExportsOfModule(mod)
}

/**
 * Get the main source module that exports all symbols
 */
function getMainModule(ctx: Context): ts.Symbol {
    const symbol = ctx.checker.getSymbolAtLocation(ctx.sourceFile)
    assert(symbol !== undefined)

    return symbol
}

/**
 * Infer a signature guess for the given symbol and add it to the schema.
 */
function infer(ctx: Context, symbol: ts.Symbol): void {
    if (isClass(symbol)) {
        inferClassType(ctx, symbol)
        return
    }

    const type = ctx.checker.getTypeOfSymbol(symbol)
    if (isFunction(type)) {
        inferFunctionType(ctx, symbol)
        return
    }

    // this symbol is not a function or class, skip
}

/**
 * Checks if a symbol represents a class type.
 *
 * If the symbol is "A" in `class A {}`, then `checker.getTypeOfSymbol(symbol)` gets
 * us `Function`. Then doing a `type.isClass()` on it isn't really what we want. Instead,
 * we want to check if "A" itself is a class. `SymbolFlags.Class` is that marker.
 */
function isClass(symbol: ts.Symbol): boolean {
    return !!(symbol.flags & ts.SymbolFlags.Class)
}

/**
 * Check if a given TypeScript type is a function. Classes do not count as functions this way.
 */
function isFunction(type: ts.Type): boolean {
    return type.getCallSignatures().length > 0
}

/**
 * Merge signature guesses derived from function overloads into a single signature guess.
 */
function mergeFunctionOverloads(guesses: SignatureGuess[]): SignatureGuess {
    assert(guesses.length > 0)

    const callconv = guesses[0].callconv
    assert(guesses.every(g => g.callconv === callconv))

    const maxArgc = Math.max(...guesses.map(g => g.args.length))
    const args: TypeGuess[] = []
    for (let i = 0; i < maxArgc; ++i) {
        const arg = Guess.union(...guesses.map(g => g.args[i] ?? Guess.undefined()))
        args.push(arg)
    }

    const ret = Guess.union(...guesses.map(g => g.ret))

    return { args, ret, callconv }
}

/**
 * Infers a function signature for `symbol`. Adds the signature to the schema,
 * using `symbol` to derive an endpoint name.
 */
function inferFunctionType(ctx: Context, symbol: ts.Symbol): void {
    const callconv = "Free"
    const type = ctx.checker.getTypeOfSymbol(symbol)

    const guesses = type.getCallSignatures()
        .map(call => guessSignature(ctx.checker, call, callconv))

    const name = symbol.getName()
    ctx.schema[name] = mergeFunctionOverloads(guesses)
}

function guessSignature(checker: ts.TypeChecker, sig: ts.Signature, callconv: CallConvention): SignatureGuess {
    const args = sig.getParameters()
            .map(p => functionArgTypeGuess(checker, p))

    // Railcar calls all endpoints with an await, so we consider a `Promise<T>` to be just `T`
    const unwrapped = unwrapPromise(checker, sig.getReturnType())
    const ret = toTypeGuess(checker, unwrapped)

    return { args, ret, callconv }
}

function unwrapPromise(checker: ts.TypeChecker, type: ts.Type): ts.Type {
    const symbol = type.getSymbol()
    if (symbol === undefined) return type

    if (symbol.getName() === "Promise") {
        const typeArgs = checker.getTypeArguments(type as ts.TypeReference)
        assert(typeArgs.length > 0)
        return typeArgs[0]
    }

    return type
}

function isOptionalParameter(checker: ts.TypeChecker, arg: ts.Symbol): boolean {
    assert(arg.declarations !== undefined)
    assert(arg.declarations.length === 1)

    const declaration = arg.declarations[0]
    assert(ts.isParameter(declaration))

    return checker.isOptionalParameter(declaration)
}

function functionArgTypeGuess(checker: ts.TypeChecker, arg: ts.Symbol): TypeGuess {
    const type = checker.getTypeOfSymbol(arg)
    const guess = toTypeGuess(checker, type)

    if (isOptionalParameter(checker, arg)) {
        return Guess.union(guess, Guess.undefined())
    }

    return guess
}

function isTrueLiteral(checker: ts.TypeChecker, type: ts.Type): boolean {
    if (type.getFlags() & ts.TypeFlags.BooleanLiteral) {
        const name = checker.typeToString(type)
        return name === "true"
    }
    return false
}

function isFalseLiteral(checker: ts.TypeChecker, type: ts.Type): boolean {
    if (type.getFlags() & ts.TypeFlags.BooleanLiteral) {
        const name = checker.typeToString(type)
        return name === "false"
    }
    return false
}

/**
 * Merge `true | false` into `boolean`
 *
 * TypeScript considers `boolean` to be `true | false`, so a `boolean | string` becomes
 * `true | false |  string` instead, which affects the relative weight in the final
 * probability distribution.
 */
function mergeUnionBooleans(checker: ts.TypeChecker, types: ts.Type[]): ts.Type[] {
    const nonBoolTypes = []
    let trueCount = 0
    let falseCount = 0
    for (const type of types) {
        if (isTrueLiteral(checker, type)) {
            trueCount++
        } else if (isFalseLiteral(checker, type)) {
            falseCount++
        } else {
            nonBoolTypes.push(type)
        }
    }

    while (trueCount > 0 && falseCount > 0) {
        nonBoolTypes.push(checker.getBooleanType())
        trueCount--
        falseCount--
    }

    // if there's still more of these, add a boolean for each of them
    const rem = Math.max(trueCount, falseCount)
    for (let i = 0; i < rem; ++i) {
        nonBoolTypes.push(checker.getBooleanType())
    }

    return nonBoolTypes
}

function toTypeGuess(checker: ts.TypeChecker, type: ts.Type): TypeGuess {
    const flags = type.getFlags()

    if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) {
        return Guess.any()
    }

    if (flags & ts.TypeFlags.String || flags & ts.TypeFlags.StringLiteral) {
        return Guess.string()
    }

    if (flags & ts.TypeFlags.Number || flags & ts.TypeFlags.NumberLiteral) {
        return Guess.number()
    }

    if (flags & ts.TypeFlags.Boolean || flags & ts.TypeFlags.BooleanLiteral) {
        return Guess.boolean()
    }

    if (flags & ts.TypeFlags.Undefined || flags & ts.TypeFlags.Void) {
        return Guess.undefined()
    }

    if (flags & ts.TypeFlags.Null) {
        return Guess.null()
    }

    if (type.isUnion()) {
        const types = mergeUnionBooleans(checker, type.types)
        const members = types.map(t => toTypeGuess(checker, t))
        return Guess.union(...members)
    }

    if (type.isIntersection()) {
        const members = type.types.map(t => toTypeGuess(checker, t))
        return Guess.intersect(...members)
    }

    if (checker.isTupleType(type) || checker.isArrayType(type)) {
        const typeArgs = checker.getTypeArguments(type as ts.TypeReference)
        assert(typeArgs.length > 0)

        const elements = typeArgs.map(t => toTypeGuess(checker, t))
        return Guess.array(Guess.union(...elements))
    }

    if (type.isClass()) {
        const symbol = type.getSymbol()
        assert(symbol !== undefined)
        return Guess.class(symbol.getName())
    }

    if (isFunction(type)) {
        return Guess.func()
    }

    if (flags & ts.TypeFlags.Object) {
        const properties = type.getProperties()
        const shape: Record<string, TypeGuess> = {}
        for (const prop of properties) {
            const propName = prop.getName()
            const propType = checker.getTypeOfSymbol(prop)
            const guess = toTypeGuess(checker, propType)

            if (prop.flags & ts.SymbolFlags.Optional) {
                shape[propName] = Guess.union(guess, Guess.undefined())
            } else {
                shape[propName] = guess
            }
        }
        return Guess.object(shape)
    }

    return Guess.any()
}

function makeConstructor(checker: ts.TypeChecker, name: string, type: ts.Type): SignatureGuess {
    const guesses = type.getConstructSignatures()
        .map(sig => guessSignature(checker, sig, "Constructor"))

    // merge all the overloads, but set the return type to the class we're constructing
    const constructor = mergeFunctionOverloads(guesses)
    constructor.ret = Guess.class(name)
    assert(constructor.callconv === "Constructor")

    return constructor

}

function inferClassType(ctx: Context, symbol: ts.Symbol): void {
    const name = symbol.getName()
    const type = ctx.checker.getTypeOfSymbol(symbol)

    ctx.schema[name] = makeConstructor(ctx.checker, name, type)

    // Static methods from the constructor type
    const staticProperties = type.getProperties()
    for (const prop of staticProperties) {
        const propType = ctx.checker.getTypeOfSymbol(prop)
        if (!isFunction(propType)) {
            continue
        }

        const guesses = propType.getCallSignatures()
            .map(sig => guessSignature(ctx.checker, sig, "Free"))
        const signature = mergeFunctionOverloads(guesses)

        const methodName = `${name}.${prop.getName()}`
        ctx.schema[methodName] = signature
    }

    // Instance methods from the declared type
    const instanceType = ctx.checker.getDeclaredTypeOfSymbol(symbol)
    const properties = instanceType.getProperties()

    // Also collect methods from implemented interfaces
    assert(symbol.declarations)
    assert(symbol.declarations.length > 0)
    const decl = symbol.declarations[0]

    if (ts.isClassDeclaration(decl) && decl.heritageClauses) {
        for (const clause of decl.heritageClauses) {
            if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                for (const typeNode of clause.types) {
                    const interfaceType = ctx.checker.getTypeAtLocation(typeNode)
                    properties.push(...interfaceType.getProperties())
                }
            }
        }
    }

    for (const prop of properties) {
        const propType = ctx.checker.getTypeOfSymbol(prop)
        if (!isFunction(propType)) {
            continue
        }

        const guesses = propType.getCallSignatures()
            .map(sig => guessSignature(ctx.checker, sig, "Method"))
            .map(g => ({
                args: [Guess.class(name), ...g.args],
                ret: g.ret,
                callconv: g.callconv,
            }))

        const methodName = `${name}.${prop.getName()}`
        ctx.schema[methodName] = mergeFunctionOverloads(guesses)
    }
}
