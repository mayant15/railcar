/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Derive a Railcar schema from a given TypeScript declaration (.d.ts) file.
 *
 * Main heuristics:
 * 1. mergeUnionBooleans
 */

import assert from "node:assert"

import ts from "typescript"

import { SignatureGuess, type TypeGuess, type Schema, type CallConvention } from "./schema.js";
import { Guess } from "./common.js";

/**
 * Produce a schema from a TypeScript declaration file.
 */
export function fromFile(path: string): Schema {
    const ctx = createContext(path)
    const exports = getExportedSymbols(ctx)

    for (const exp of exports) {
        infer(ctx, exp)
    }

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
    if (symbol.flags & ts.SymbolFlags.Class) {
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
 * Check if a given TypeScript type is a function
 * NOTE: Classes do not count as functions this way. Use ts.Type.isClass() for classes instead.
 */
function isFunction(type: ts.Type): boolean {
    const calls = type.getCallSignatures()
    return calls.length > 0
}

function inferFunctionType(ctx: Context, symbol: ts.Symbol): void {
    const callconv = "Free"
    const type = ctx.checker.getTypeOfSymbol(symbol)

    const calls = type.getCallSignatures()
    const guesses = calls.map(call => guessSignature(ctx.checker, call, callconv))

    assert(guesses.every(g => g.callconv === callconv))

    const argc = Math.max(...guesses.map(g => g.args.length))
    const args: TypeGuess[] = []
    for (let i = 0; i < argc; ++i) {
        const arg = Guess.union(...guesses.map(g => g.args[i] ?? Guess.undefined()))
        args.push(arg)
    }

    const ret = Guess.union(...guesses.map(g => g.ret))

    const name = symbol.getName()
    ctx.schema[name] = { args, ret, callconv }
}

function guessSignature(checker: ts.TypeChecker, sig: ts.Signature, callconv: CallConvention): SignatureGuess {
    const args = sig.getParameters()
    const argTypeGuesses = args.map(p => functionArgTypeGuess(checker, p))

    const returnType = sig.getReturnType()
    const unwrappedReturnType = unwrapPromise(returnType)
    const returnTypeGuess = toTypeGuess(checker, unwrappedReturnType)

    return {
        args: argTypeGuesses,
        ret: returnTypeGuess,
        callconv
    }
}

function unwrapPromise(type: ts.Type): ts.Type {
    const symbol = type.getSymbol()
    if (symbol?.getName() === "Promise") {
        const typeArgs = (type as ts.TypeReference).typeArguments
        if (typeArgs && typeArgs.length > 0) {
            return typeArgs[0]
        }
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

    if (isArrayType(type)) {
        const typeArgs = (type as ts.TypeReference).typeArguments
        const elementType = typeArgs?.[0]
        return Guess.array(elementType ? toTypeGuess(checker, elementType) : Guess.any())
    }

    if (type.isClass()) {
        const symbol = type.getSymbol()
        return Guess.class(symbol?.getName() ?? "Unknown")
    }

    if (isFunction(type)) {
        return Guess.func()
    }

    if (flags & ts.TypeFlags.Object) {
        const properties = type.getProperties()
        const shape: Record<string, TypeGuess> = {}
        for (const prop of properties) {
            const propType = prop.valueDeclaration
                ? checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration)
                : checker.getTypeOfSymbol(prop)
            let guess = toTypeGuess(checker, propType)

            const isOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0
            if (isOptional) {
                guess = Guess.union(guess, Guess.undefined())
            }

            shape[prop.getName()] = guess
        }
        return Guess.object(shape)
    }

    return Guess.any()
}

function isArrayType(type: ts.Type): boolean {
    const symbol = type.getSymbol()
    return symbol?.getName() === "Array"
}

function inferClassType(ctx: Context, symbol: ts.Symbol): void {
    const name = symbol.getName()
    const type = ctx.checker.getTypeOfSymbol(symbol)

    const constructSignatures = type.getConstructSignatures()
    const argTypeGuesses = constructSignatures.length > 0
        ? constructSignatures[0].getParameters().map(p => functionArgTypeGuess(ctx.checker, p))
        : []

    ctx.schema[name] = {
        args: argTypeGuesses,
        ret: Guess.class(name),
        callconv: "Constructor"
    }

    const instanceType = ctx.checker.getDeclaredTypeOfSymbol(symbol)
    const properties = instanceType.getProperties()

    for (const prop of properties) {
        const propType = ctx.checker.getTypeOfSymbol(prop)
        if (!isFunction(propType)) {
            continue
        }

        const calls = propType.getCallSignatures()
        if (calls.length === 0) {
            continue
        }

        const methodName = `${name}.${prop.getName()}`
        ctx.schema[methodName] = guessSignature(ctx.checker, calls[0], "Method")
    }
}
