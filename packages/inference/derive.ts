/**
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Derive a Railcar schema from a given TypeScript declaration (.d.ts) file.
 *
 * Main heuristics:
 * 1. mergeUnionTypes
 * 2. Tuples are arrays with unions for values
 * 3. A `Promise<T>` return is just `T`
 * 4. Record<K, V> are Guess.object({})
 * 5. Promote generics to their constraints, unconstrained generics are `any`
 * 6. Symbol becomes any
 * 7. Recursive types deeper than MAX_TYPE_DEPTH are `any`
 * 8. Large objects with more than MAX_OBJECT_PROPERTIES only have the first MAX_OBJECT_PROPERTIES
 */

import assert from "node:assert"

import ts from "typescript"

import { SignatureGuess, type TypeGuess, type Schema, type CallConvention } from "./schema.js";
import { addStd, Guess, STD_CLASSES, BUILTIN_METHOD_NAMES } from "./common.js"

const MAX_TYPE_DEPTH = 8
const MAX_OBJECT_PROPERTIES = 20

/**
 * Produce a schema from a TypeScript declaration file.
 */
export function fromFile(path: string): Schema {
    const ctx = createContext(path)

    const exportEquals = getExportEqualsType(ctx)
    if (exportEquals) {
        // Module uses `export = X`. The API surface is the properties of X's type.
        inferPropertiesOfType(ctx, exportEquals)
    } else {
        const exports = getExportedSymbols(ctx)
        for (const exp of exports) {
            infer(ctx, exp)
        }
    }

    addStd(ctx.schema)
    return ctx.schema
}

type Context = {
    checker: ts.TypeChecker
    sourceFile: ts.SourceFile
    schema: Schema
    builtins: Set<string>
    visiting: Set<ts.Type>
    depth: number
}

function createContext(path: string): Context {
    const program = ts.createProgram({
        rootNames: [path],
        options: {
            noEmit: true
        }
    })

    const sourceFile = program.getSourceFile(path)
    assert(sourceFile !== undefined)

    const checker = program.getTypeChecker()
    const builtins = new Set(STD_CLASSES)

    return { checker, sourceFile, builtins, schema: {}, visiting: new Set(), depth: 0 }
}

/**
 * Gets all symbols that will eventually become entries in the schema
 */
function getExportedSymbols(ctx: Context): ts.Symbol[] {
    const mod = getMainModule(ctx)
    return ctx.checker.getExportsOfModule(mod)
}

/**
 * Get the main source module that exports all symbols.
 *
 * If the source file uses `declare module 'name' { ... }` (ambient module declaration),
 * `getSymbolAtLocation` returns undefined. In that case, find the declared module
 * statement and resolve its symbol instead.
 */
function getMainModule(ctx: Context): ts.Symbol {
    const symbol = ctx.checker.getSymbolAtLocation(ctx.sourceFile)
    if (symbol !== undefined) {
        return symbol
    }

    for (const statement of ctx.sourceFile.statements) {
        if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
            const modSymbol = ctx.checker.getSymbolAtLocation(statement.name)
            if (modSymbol !== undefined) {
                return modSymbol
            }
        }
    }

    throw Error(`Could not find module symbol for ${ctx.sourceFile.fileName}`)
}

/**
 * If the module uses `export = X` where X is a variable (e.g., `declare const _: _.LoDashStatic`),
 * resolve X and return its type. The API surface is the properties of that type.
 *
 * Returns undefined if the module does not use `export =`, or if the export target is only
 * a namespace (not a variable), in which case the regular `getExportedSymbols` path handles it.
 */
function getExportEqualsType(ctx: Context): ts.Type | null {
    const mod = getMainModule(ctx)
    const exports = mod.exports
    if (!exports) return null

    const exportEquals = exports.get(ts.InternalSymbolName.ExportEquals)
    if (!exportEquals) return null

    const resolved = exportEquals.flags & ts.SymbolFlags.Alias
        ? ctx.checker.getAliasedSymbol(exportEquals)
        : exportEquals

    // Only use the type-based inference when the export target is a variable.
    // Pure namespaces (e.g., `declare namespace X { ... }; export = X`) are handled
    // by the regular getExportedSymbols path.
    const isVariable = resolved.flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.FunctionScopedVariable | ts.SymbolFlags.BlockScopedVariable)
    if (!isVariable) return null

    return ctx.checker.getTypeOfSymbol(resolved)
}

/**
 * Infer signatures from the callable properties of a type and add them to the schema.
 */
function inferPropertiesOfType(ctx: Context, type: ts.Type): void {
    for (const prop of type.getProperties()) {
        const propType = ctx.checker.getTypeOfSymbol(prop)
        const name = prop.getName()

        if (isFunction(propType)) {
            if (BUILTIN_METHOD_NAMES.has(name)) continue
            const guesses = propType.getCallSignatures()
                .map(sig => guessSignature(ctx, sig, "Free"))
            ctx.schema[name] = mergeFunctionOverloads(guesses)
        } else if (isClass(prop)) {
            inferClassType(ctx, prop)
        }
    }
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
 * Check if a given TypeScript type is a function.
 *
 * Classes do not count as functions this way. The type `Function` is a function.
 */
function isFunction(type: ts.Type): boolean {
    if (type.getCallSignatures().length > 0) {
        return true
    }

    const symbol = type.getSymbol()
    return (symbol?.getName() === "Function")
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
        .map(call => guessSignature(ctx, call, callconv))

    const name = symbol.getName()
    ctx.schema[name] = mergeFunctionOverloads(guesses)
}

function guessSignature(ctx: Context, sig: ts.Signature, callconv: CallConvention): SignatureGuess {
    const args = sig.getParameters()
            .map(p => functionArgTypeGuess(ctx, p))

    // Railcar calls all endpoints with an await, so we consider a `Promise<T>` to be just `T`
    const unwrapped = unwrapPromise(ctx.checker, sig.getReturnType())
    const ret = toTypeGuessOrAny(ctx, unwrapped)

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

function functionArgTypeGuess(ctx: Context, arg: ts.Symbol): TypeGuess {
    const type = ctx.checker.getTypeOfSymbol(arg)
    const guess = toTypeGuessOrAny(ctx, type)

    if (isOptionalParameter(ctx.checker, arg)) {
        return Guess.union(guess, Guess.undefined())
    }

    return guess
}

/**
 * Promote a literal type to a base primitive type.
 */
function promoteType(checker: ts.TypeChecker, type: ts.Type): ts.Type {
    const flags = type.getFlags()
    if (!(flags & ts.TypeFlags.Literal)) {
        return type
    }

    if (flags & ts.TypeFlags.StringLiteral || flags & ts.TypeFlags.TemplateLiteral) {
        return checker.getStringType()
    }

    if (flags & ts.TypeFlags.BooleanLiteral) {
        return checker.getBooleanType()
    }

    if (flags & ts.TypeFlags.EnumLiteral || flags & ts.TypeFlags.NumberLiteral || flags & ts.TypeFlags.BigIntLiteral) {
        return checker.getNumberType()
    }

    throw Error("unreachable")
}

/**
 * Remove duplicates of the same type from the union.
 *
 * TypeChecker.getXXXType() returns *the same* object for number, string, boolean types.
 * This function therefore simply deduplicates based on object references, which is the
 * default behaviour for Set.
 */
function dedupeUnionTypes(types: ts.Type[]): ts.Type[] {
    // at no point this makes new type objects. toArray() returns the same objects
    // that are in types.
    return (new Set(types)).values().toArray()
}

/**
 * Merge union constituents like literals into one primitive type.
 */
function mergeUnionTypes(checker: ts.TypeChecker, types: ts.Type[]): ts.Type[] {
    return dedupeUnionTypes(types.map(t => promoteType(checker, t)))
}

function toTypeGuessOrAny(ctx: Context, type: ts.Type): TypeGuess {
    return toTypeGuess(ctx, type) ?? Guess.any()
}

function toTypeGuess(ctx: Context, type: ts.Type): TypeGuess | null {
    if (ctx.visiting.has(type) || ctx.depth >= MAX_TYPE_DEPTH) {
        return null
    }

    ctx.depth++
    const result = toTypeGuessInner(ctx, type)
    ctx.depth--
    return result
}

function toTypeGuessInner(ctx: Context, type: ts.Type): TypeGuess | null {
    const flags = type.getFlags()

    if (flags & ts.TypeFlags.TypeParameter) {
        const constraint = (type as ts.TypeParameter).getConstraint()
        if (constraint) {
            return toTypeGuess(ctx, constraint)
        }
        return Guess.any()
    }

    if (flags & ts.TypeFlags.Any || flags & ts.TypeFlags.Unknown) {
        return Guess.any()
    }

    if (flags & ts.TypeFlags.Undefined || flags & ts.TypeFlags.Void) {
        return Guess.undefined()
    }

    if (flags & ts.TypeFlags.Null) {
        return Guess.null()
    }

    if (flags & ts.TypeFlags.ESSymbol || flags & ts.TypeFlags.UniqueESSymbol) {
        return null
    }

    if (flags & ts.TypeFlags.Literal) {
        return toTypeGuess(ctx, promoteType(ctx.checker, type))
    }
    assert(!(flags & ts.TypeFlags.Literal))

    if (flags & ts.TypeFlags.String) {
        return Guess.string()
    }

    if (flags & ts.TypeFlags.Number) {
        return Guess.number()
    }

    if (flags & ts.TypeFlags.Boolean) {
        return Guess.boolean()
    }

    // handles `x: object`
    if (flags & ts.TypeFlags.NonPrimitive) {
        return Guess.object({})
    }

    if (type.isUnion()) {
        ctx.visiting.add(type)
        const types = mergeUnionTypes(ctx.checker, type.types)
        const members = types
            .map(t => toTypeGuess(ctx, t))
            .filter(t => t !== null)

        ctx.visiting.delete(type)
        return members.length > 0 ? Guess.union(...members) : null
    }

    if (type.isIntersection()) {
        ctx.visiting.add(type)
        const members = type.types
            .map(t => toTypeGuess(ctx, t))
            .filter(t => t !== null)

        ctx.visiting.delete(type)
        return members.length > 0 ? Guess.intersect(...members) : null
    }

    if (ctx.checker.isTupleType(type) || ctx.checker.isArrayType(type)) {
        const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference)
        assert(typeArgs.length > 0)

        ctx.visiting.add(type)
        const elements = typeArgs.map(t => toTypeGuessOrAny(ctx, t))
        ctx.visiting.delete(type)
        return Guess.array(Guess.union(...elements))
    }

    if (type.isClass()) {
        const symbol = type.getSymbol()
        assert(symbol !== undefined)
        return Guess.class(symbol.getName())
    }

    // Built-in classes like Uint8Array don't pass isClass()
    const symbol = type.getSymbol()
    if (symbol !== undefined) {
        const name = symbol.getName()
        if (name === "Symbol") {
            return Guess.any()
        }
        if (ctx.builtins.has(name)) {
            return Guess.class(name)
        }
    }

    if (isFunction(type)) {
        return Guess.func()
    }

    if (flags & ts.TypeFlags.Object) {
        const properties = type.getProperties().slice(0, MAX_OBJECT_PROPERTIES)

        ctx.visiting.add(type)
        const shape: Record<string, TypeGuess> = {}
        for (const prop of properties) {
            const propName = prop.getName()
            const propType = ctx.checker.getTypeOfSymbol(prop)
            const guess = toTypeGuessOrAny(ctx, propType)

            if (prop.flags & ts.SymbolFlags.Optional) {
                shape[propName] = Guess.union(guess, Guess.undefined())
            } else {
                shape[propName] = guess
            }
        }
        ctx.visiting.delete(type)
        return Guess.object(shape)
    }

    return null
}

function makeConstructor(ctx: Context, name: string, type: ts.Type): SignatureGuess {
    const guesses = type.getConstructSignatures()
        .map(sig => guessSignature(ctx, sig, "Constructor"))

    // merge all the overloads, but set the return type to the class we're constructing
    const constructor = mergeFunctionOverloads(guesses)
    constructor.ret = Guess.class(name)
    assert(constructor.callconv === "Constructor")

    return constructor

}

function inferClassType(ctx: Context, symbol: ts.Symbol): void {
    const name = symbol.getName()
    const type = ctx.checker.getTypeOfSymbol(symbol)

    ctx.schema[name] = makeConstructor(ctx, name, type)

    // Static methods from the constructor type
    const staticProperties = type.getProperties()
    for (const prop of staticProperties) {
        const propType = ctx.checker.getTypeOfSymbol(prop)
        if (!isFunction(propType)) {
            continue
        }

        if (BUILTIN_METHOD_NAMES.has(prop.getName())) continue;

        const guesses = propType.getCallSignatures()
            .map(sig => guessSignature(ctx, sig, "Free"))
        const signature = mergeFunctionOverloads(guesses)

        const methodName = `${name}.${prop.getName()}`
        ctx.schema[methodName] = signature
    }

    // Instance methods from the declared type
    const instanceType = ctx.checker.getDeclaredTypeOfSymbol(symbol)

    // This is a reference to the properties object on the type. Make a copy because
    // we are going to mutate it here.
    const properties = [...instanceType.getProperties()]

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

        if (BUILTIN_METHOD_NAMES.has(prop.getName())) continue;

        const guesses = propType.getCallSignatures()
            .map(sig => guessSignature(ctx, sig, "Method"))
            .map(g => ({
                args: [Guess.class(name), ...g.args],
                ret: g.ret,
                callconv: g.callconv,
            }))

        const methodName = `${name}.${prop.getName()}`
        ctx.schema[methodName] = mergeFunctionOverloads(guesses)
    }
}
