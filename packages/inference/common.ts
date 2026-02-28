// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";
import { Duplex } from "node:stream";

import type {
    Schema,
    SignatureGuess,
    TypeGuess,
    Type,
    EndpointName,
} from "./schema.ts";

import { TypeKinds } from "./schema.js";

function mergeProbabilityObjects<T extends string | number>(
    keys: readonly T[],
    objects: Partial<Record<T, number>>[],
): Partial<Record<T, number>> {
    const result: Partial<Record<T, number>> = {};
    for (const key of keys) {
        const existing = objects.map((obj) => obj[key] ?? 0);

        // skip if probability for this key is always zero
        if (existing.every((p) => p === 0)) {
            continue;
        }

        const next = existing
            .map((p) => p / objects.length)
            .reduce((acc, x) => acc + x, 0);

        // truncate to 3 decimal places, floating point precision issues
        result[key] = Math.round(next * 1e3) / 1e3;
    }
    return result;
}

function properties(objects: Record<string, unknown>[]): string[] {
    return objects
        .reduce(
            (set, obj) => set.union(new Set(Object.keys(obj))),
            new Set<string>(),
        )
        .values()
        .toArray();
}

function nonZeroTypeKinds(g: TypeGuess): Set<string> {
    const keys = Object.entries(g.kind)
        .filter(([_, value]) => value > 0)
        .map(([key]) => key);
    return new Set(keys);
}

function pickBiggerGuess(a: TypeGuess, b: TypeGuess): TypeGuess {
    if (a.isAny || b.isAny) {
        return a.isAny ? a : b;
    }

    const aKeys = nonZeroTypeKinds(a);
    const bKeys = nonZeroTypeKinds(b);
    const aUniq = aKeys.difference(bKeys);
    const bUniq = bKeys.difference(aKeys);

    // return the bigger one if one is a strict strict superset of the other
    if (aUniq.size === 0 || bUniq.size === 0) {
        return aUniq.size === 0 ? b : a;
    }

    // not a strict superset based on type kind, return left
    return a;
}

export const Types = {
    null(): Type {
        return "Null";
    },

    undefined(): Type {
        return "Undefined";
    },

    boolean(): Type {
        return "Boolean";
    },

    number(): Type {
        return "Number";
    },

    string(): Type {
        return "String";
    },

    func(): Type {
        return "Function";
    },

    class(cls: EndpointName): Type {
        return {
            Class: cls,
        };
    },

    object(shape: Record<string, Type>): Type {
        return {
            Object: shape,
        };
    },

    array(value: Type): Type {
        return {
            Array: value,
        };
    },
};

export const Guess = {
    object(shape: Record<string, TypeGuess>): TypeGuess {
        return {
            isAny: false,
            kind: {
                Object: 1.0,
            },
            objectShape: shape,
        };
    },

    array(valueType: TypeGuess): TypeGuess {
        return {
            isAny: false,
            kind: {
                Array: 1,
            },
            arrayValueType: valueType,
        };
    },

    class(cls: EndpointName) {
        return {
            isAny: false,
            kind: {
                Class: 1.0,
            },
            classType: {
                [cls]: 1.0,
            },
        };
    },

    exact(x: Type): TypeGuess {
        if (typeof x === "string") {
            return {
                isAny: false,
                kind: {
                    [x]: 1.0,
                },
            };
        }

        if ("Object" in x) {
            const shape = Object.entries(x.Object).reduce(
                (acc, [prop, ty]) => {
                    acc[prop] = Guess.exact(ty);
                    return acc;
                },
                {} as Record<string, TypeGuess>,
            );
            return Guess.object(shape);
        }

        if ("Class" in x) {
            return Guess.class(x.Class);
        }

        if ("Array" in x) {
            return Guess.array(Guess.exact(x.Array));
        }

        throw Error("invalid type");
    },

    union(...gs: TypeGuess[]): TypeGuess {
        if (gs.length === 0) {
            return Guess.any();
        }

        // union with any is any
        if (gs.some(g => g.isAny)) {
            return Guess.any();
        }

        const res: TypeGuess = {
            isAny: false,
            kind: {},
        };

        res.kind = mergeProbabilityObjects(
            TypeKinds,
            gs.map((g) => g.kind),
        );

        if (res.kind.Class) {
            const classTypes = gs
                .filter((g) => g.classType !== undefined)
                .map((g) => {
                    assert(g.classType !== undefined);
                    return g.classType;
                });
            const constructors = properties(classTypes);
            res.classType = mergeProbabilityObjects(constructors, classTypes);
        }

        if (res.kind.Array) {
            const arrayTypes = gs
                .filter((g) => g.arrayValueType !== undefined)
                .map((g) => {
                    assert(g.arrayValueType !== undefined);
                    return g.arrayValueType;
                });
            res.arrayValueType = Guess.union(...arrayTypes);
        }

        // similar to mergeProbabilityObjects above
        if (res.kind.Object) {
            res.objectShape = {};
            const shapes = gs
                .filter((g) => g.objectShape !== undefined)
                .map((g) => {
                    assert(g.objectShape !== undefined);
                    return g.objectShape;
                });
            const keys = properties(shapes);
            for (const key of keys) {
                const existing = shapes.map(
                    (obj) => Object.hasOwn(obj, key) ? obj[key] : Guess.exact(Types.undefined()),
                );
                res.objectShape[key] = Guess.union(...existing);
            }
        }

        return res;
    },

    intersect(...gs: TypeGuess[]): TypeGuess {
        const noAny = gs.filter((g) => !g.isAny);
        if (noAny.length === 0) {
            return Guess.any();
        }

        const objects = noAny.filter(
            (g) => g.objectShape !== undefined && g.kind.Object! === 1,
        );

        if (objects.length === 0) {
            return Guess.union(...noAny);
        }

        const objectShape = objects
            .map((g) => {
                assert(g.objectShape !== undefined);
                return g.objectShape;
            })
            .reduce((acc, shape) => {
                const props = Object.keys(shape);
                for (const prop of props) {
                    if (!Object.hasOwn(acc, prop)) {
                        acc[prop] = shape[prop];
                    } else {
                        acc[prop] = pickBiggerGuess(acc[prop], shape[prop]);
                    }
                }
                return acc;
            });

        return {
            isAny: false,
            kind: {
                Object: 1.0,
            },
            objectShape,
        };
    },

    optional(ty: Type): TypeGuess {
        return Guess.union(Guess.exact(ty), Guess.exact(Types.undefined()));
    },

    any(): TypeGuess {
        return {
            isAny: true,
            kind: {},
        };
    },

    undefined(): TypeGuess {
        return Guess.exact(Types.undefined());
    },

    boolean(): TypeGuess {
        return Guess.exact(Types.boolean());
    },

    number(): TypeGuess {
        return Guess.exact(Types.number());
    },

    string(): TypeGuess {
        return Guess.exact(Types.string());
    },

    null(): TypeGuess {
        return Guess.exact(Types.null());
    },

    func(): TypeGuess {
        return Guess.exact(Types.func());
    },

    canBe(guess: TypeGuess, query: Type): boolean {
        if (typeof query === "string") {
            return guess.kind[query] !== undefined && guess.kind[query] > 0
        }

        if ("Class" in query) {
            return (
                guess.kind.Class !== undefined
                && guess.kind.Class > 0
                && guess.classType !== undefined
                && guess.classType[query.Class] !== undefined
                && guess.classType[query.Class]! > 0
            )
        }

        if ("Array" in query) {
            return (
                guess.kind.Array !== undefined
                && guess.kind.Array > 0
                && guess.arrayValueType !== undefined
                && Guess.canBe(guess.arrayValueType, query.Array)
            )
        }

        if ("Object" in query) {
            if (guess.kind.Object === undefined || guess.kind.Object <= 0) return false
            assert(guess.objectShape)

            const queryProperties = new Set(Object.keys(query.Object))
            const shapeProperties = new Set(Object.keys(guess.objectShape))

            // TODO: we don't match property types here, just keys
            return queryProperties.isSubsetOf(shapeProperties)
        }

        throw Error("unreachable")
    }
};

function addBuiltInClass(
    schema: Schema,
    constr: { name: string },
    args: TypeGuess[] = [],
) {
    const name = constr.name
    const type = Types.class(name);
    schema[name] = {
        args,
        ret: Guess.exact(type),
        callconv: "Constructor",
        builtin: true,
    };
}

export const STD_CLASSES = [
    "Uint8Array",
    "ArrayBuffer",
    "RegExp",
    "Buffer",
    "SharedArrayBuffer",
    "Error",
    "Duplex",
] as const;

export const BUILTIN_METHOD_NAMES = new Set([
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "valueOf",
    "toLocaleString",
    "toString",
])

/**
 * Add standard built-in classes to a schema.
 */
export function addStd(schema: Schema) {
    addBuiltInClass(schema, Uint8Array, [])
    addBuiltInClass(
        schema,
        ArrayBuffer,
        [Guess.exact(Types.number())],
    )
    addBuiltInClass(schema, RegExp, [])
    addBuiltInClass(
        schema,
        SharedArrayBuffer,
        [Guess.number()],
    )
    addBuiltInClass(schema, Error, [Guess.optional(Types.string())])
    addBuiltInClass(schema, Duplex, [])

    // new Buffer is deprecated. Node prefers Buffer.alloc() or Buffer.from()
    schema["Buffer.from"] = {
        args: [Guess.string()],
        ret: Guess.class("Buffer"),
        callconv: "Free",
        builtin: true,
    }
}
