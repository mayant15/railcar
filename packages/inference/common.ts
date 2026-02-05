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
                    (obj) => obj[key] ?? Guess.exact(Types.undefined()),
                );
                res.objectShape[key] = Guess.union(...existing);
            }
        }

        return res;
    },

    intersect(...gs: TypeGuess[]): TypeGuess {
        const noAny = gs.filter((g) => !g.isAny);
        assert(noAny.length > 0);
        assert(
            noAny.every(
                (g) => g.objectShape !== undefined && g.kind.Object! === 1,
            ),
            "intersections can only be computed on objects",
        );

        const objectShape = noAny
            .map((g) => {
                assert(g.objectShape !== undefined);
                return g.objectShape;
            })
            .reduce((acc, shape) => {
                const props = Object.keys(shape);
                for (const prop of props) {
                    if (!(prop in acc)) {
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
};

export function mkClass(
    schema: Schema,
    nameOrConstr: { name: string } | string,
    args: TypeGuess[] = [],
    builtin?: boolean,
): Type {
    const name =
        typeof nameOrConstr === "string" ? nameOrConstr : nameOrConstr.name;
    const type = Types.class(name);
    schema[name] = {
        args,
        ret: Guess.exact(type),
        callconv: "Constructor",
        builtin,
    };
    return type;
}

export const Builtins = [
    "Uint8Array",
    "ArrayBuffer",
    "RegExp",
    "Buffer",
    "SharedArrayBuffer",
    "Error",
    "Duplex",
] as const;

export type StdTypes = Record<(typeof Builtins)[number], Type>;
export type StdSchema = Record<(typeof Builtins)[number], SignatureGuess>;

/**
 * Add standard built-in classes to a schema.
 */
export function addStd(schema: Schema): StdTypes {
    return {
        Uint8Array: mkClass(schema, Uint8Array, [], true),
        ArrayBuffer: mkClass(
            schema,
            ArrayBuffer,
            [Guess.exact(Types.number())],
            true,
        ),
        RegExp: mkClass(schema, RegExp, [], true),
        Buffer: mkClass(schema, Buffer, [Guess.string()], true),
        SharedArrayBuffer: mkClass(
            schema,
            SharedArrayBuffer,
            [Guess.number()],
            true,
        ),
        Error: mkClass(schema, Error, [Guess.optional(Types.string())], true),
        Duplex: mkClass(schema, Duplex, [], true),
    };
}

type ConstructSchema<Keys extends readonly string[]> = StdSchema &
    Record<Keys[number], SignatureGuess>;

const PakoEndpoints = [
    "deflate",
    "deflateRaw",
    "gzip",
    "inflate",
    "inflateRaw",
    "ungzip",
    "Inflate",
    "Inflate.onData",
    "Inflate.onEnd",
    "Inflate.push",
    "Deflate",
    "Deflate.onData",
    "Deflate.onEnd",
    "Deflate.push",
] as const;

const ProtobufEndpoints = [
    "Root",
    "Root.loadSync",
    "Root.define",
    "Root.lookupType",

    "Type",
    "Type.create",
    "Type.decode",

    "Reader",
    "Message",
    "Namespace",

    // NOTE: These are used in the OSS-Fuzz driver but not in my version of the library
    // Message.set
    // Message.encode
    // Root.create
] as const;

const FastXmlParserEndpoints = [
    "XMLParser",
    "XMLParser.parse",
    "XMLParser.addEntity",
    "XMLBuilder",
    "XMLBuilder.build",
    "XMLValidator.validate",
] as const;

const JsYamlEndpoints = [
    "load",
    "loadAll",
    "dump",
    "Type",
    "Type.constructor",
    "Type.resolve",
    "Schema",
    "Schema.extend",
    "YAMLException",
    "YAMLException.toString",
] as const;

const SharpEndpoints = [
    "cache",

    "Sharp",
    "Sharp.removeAlpha",
    "Sharp.ensureAlpha",
    "Sharp.extractChannel",
    "Sharp.joinChannel",
    "Sharp.grayscale",
    "Sharp.pipelineColorspace",
    "Sharp.toColorspace",
    "Sharp.composite",
    "Sharp.clone",
    "Sharp.keepMetadata",
    "Sharp.rotate",
    "Sharp.flip",
    "Sharp.flop",
    "Sharp.sharpen",
    "Sharp.extend",
    "Sharp.trim",
    "Sharp.median",
    "Sharp.unflatten",
    "Sharp.flatten",
    "Sharp.gamma",
    "Sharp.gif",
    "Sharp.clahe",
    "Sharp.withMetadata",
    "Sharp.jpeg",
    "Sharp.png",
    "Sharp.webp",
    "Sharp.tiff",
    "Sharp.avif",
    "Sharp.negate",
    "Sharp.resize",
] as const;

const ExampleEndpoints = ["compress", "decompress"] as const;

type PakoSchema = ConstructSchema<typeof PakoEndpoints>;
type ProtobufSchema = ConstructSchema<typeof ProtobufEndpoints>;
type FastXmlParserSchema = ConstructSchema<typeof FastXmlParserEndpoints>;
type JsYamlSchema = ConstructSchema<typeof JsYamlEndpoints>;
type SharpSchema = ConstructSchema<typeof SharpEndpoints>;
type ExampleSchema = ConstructSchema<typeof ExampleEndpoints>;

export type BenchmarkSchemas = {
    pako: PakoSchema;
    "protobuf-js": ProtobufSchema;
    "fast-xml-parser": FastXmlParserSchema;
    "js-yaml": JsYamlSchema;
    sharp: SharpSchema;
    example: ExampleSchema;
};
