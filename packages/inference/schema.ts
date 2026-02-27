// SPDX-License-Identifier: AGPL-3.0-or-later

export type EndpointName = string;

export type Fn = (...args: unknown[]) => unknown;
export type Endpoints = Record<EndpointName, Fn>;

export type Distribution<T extends string | number> = Partial<
    Record<T, number>
>;

export const TypeKinds = [
    "Number",
    "String",
    "Boolean",
    "Object",
    "Class",
    "Array",
    "Undefined",
    "Null",
    "Function",
] as const;

export type TypeKind = (typeof TypeKinds)[number];

type ObjectType = {
    Object: Record<string, Type>;
};

type ArrayType = {
    Array: Type;
};

type ClassType = {
    Class: EndpointName;
};

export type Type =
    | "Number"
    | "String"
    | "Boolean"
    | ObjectType
    | ArrayType
    | ClassType
    | "Undefined"
    | "Null"
    | "Function";

export type CallConvention = "Free" | "Method" | "Constructor";

export type Signature = {
    args: Type[];
    ret: Type;
    callconv: CallConvention;
};

export type TypeGuess = {
    isAny: boolean;
    kind: Distribution<TypeKind>;
    objectShape?: Record<string, TypeGuess>;
    arrayValueType?: TypeGuess;
    classType?: Distribution<EndpointName>;
};

export type SignatureGuess = {
    args: TypeGuess[];
    ret: TypeGuess;
    callconv: CallConvention;
    builtin?: boolean;
};

export type Schema = Record<EndpointName, SignatureGuess>;
