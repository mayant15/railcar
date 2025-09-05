import assert from "node:assert";
import { addStd, type BenchmarkSchemas, Types, Guess, mkClass } from "./common";
import type { Schema, SignatureGuess, Type, TypeGuess } from "./schema";

function protobufJs(): BenchmarkSchemas["protobuf-js"] {
    const schema: BenchmarkSchemas["protobuf-js"] = {} as any;
    const std = addStd(schema);

    // NOTE: their type definitions don't mention the shape of options
    const OptionsT = Guess.exact(Types.object({}));

    const StringT = Guess.exact(Types.string());
    const StringOrStringArrayT = {
        isAny: false,
        kind: {
            String: 0.5,
            Array: 0.5,
        },
        arrayValueType: StringT,
    };

    const RootT = Guess.exact(mkClass(schema, "Root", [OptionsT]));
    const NamespaceT = Guess.exact(
        mkClass(schema, "Namespace", [StringT, OptionsT]),
    );
    const TypeT = Guess.exact(mkClass(schema, "Type", [StringT, OptionsT]));

    schema["Root.loadSync"] = {
        args: [RootT, StringOrStringArrayT],
        ret: RootT,
        callconv: "Method",
    };

    schema["Root.define"] = {
        args: [RootT, StringOrStringArrayT, Guess.any()],
        ret: NamespaceT,
        callconv: "Method",
    };

    schema["Root.lookupType"] = {
        args: [RootT, StringOrStringArrayT],
        ret: TypeT,
        callconv: "Method",
    };

    const MessageT = Guess.exact(mkClass(schema, "Message", [OptionsT]));
    mkClass(schema, "Reader", [Guess.exact(std.Uint8Array)]);

    schema["Type.decode"] = {
        args: [
            TypeT,
            {
                isAny: false,
                kind: {
                    Class: 1,
                },
                classType: {
                    Reader: 0.5,
                    Uint8Array: 0.5,
                },
            },
            Guess.optional(Types.number()),
        ],
        ret: MessageT,
        callconv: "Method",
    };

    schema["Type.create"] = {
        args: [TypeT, OptionsT],
        ret: MessageT,
        callconv: "Method",
    };

    return schema;
}

function pako(): BenchmarkSchemas["pako"] {
    const schema: BenchmarkSchemas["pako"] = {} as any;
    const std = addStd(schema);

    const DeflateOptions = Guess.object({
        level: Guess.optional(Types.number()),
        windowBits: Guess.optional(Types.number()),
        memLevel: Guess.optional(Types.number()),
        strategy: Guess.optional(Types.number()),
        dictionary: Guess.any(),
        raw: Guess.optional(Types.boolean()),
        chunkSize: Guess.optional(Types.number()),
        gzip: Guess.optional(Types.boolean()),
        header: Guess.union(Guess.undefined(), {
            isAny: false,
            kind: {
                Object: 1,
            },
            objectShape: {
                text: Guess.optional(Types.boolean()),
                time: Guess.optional(Types.number()),
                os: Guess.optional(Types.number()),
                extra: Guess.optional(Types.array(Types.number())),
                name: Guess.optional(Types.string()),
                comment: Guess.optional(Types.string()),
                hcrc: Guess.optional(Types.boolean()),
            },
        }),
    });

    const DeflateFunctionOptions = Guess.object({
        level: Guess.optional(Types.number()),
        windowBits: Guess.optional(Types.number()),
        memLevel: Guess.optional(Types.number()),
        strategy: Guess.optional(Types.number()),
        dictionary: Guess.any(),
        raw: Guess.optional(Types.boolean()),
    });

    const InflateOptions = Guess.object({
        windowBits: Guess.optional(Types.number()),
        dictionary: Guess.any(),
        raw: Guess.optional(Types.boolean()),
        to: Guess.optional(Types.string()),
        chunkSize: Guess.optional(Types.number()),
    });

    const InflateFunctionOptions = Guess.object({
        windowBits: Guess.optional(Types.number()),
        raw: Guess.optional(Types.boolean()),
        to: Guess.optional(Types.string()),
    });

    const Data = Guess.union(
        Guess.exact(std.Uint8Array),
        Guess.exact(std.ArrayBuffer),
    );

    // Direct exposed functions
    const deflate: SignatureGuess = {
        args: [
            Guess.union(
                Guess.exact(std.Uint8Array),
                Guess.exact(std.ArrayBuffer),
                Guess.exact(Types.string()),
            ),
            Guess.union(Guess.exact(Types.undefined()), DeflateFunctionOptions),
        ],
        ret: Guess.exact(std.Uint8Array),
        callconv: "Free",
    };

    schema["deflate"] = deflate;
    schema["deflateRaw"] = deflate;
    schema["gzip"] = deflate;

    const inflate: SignatureGuess = {
        args: [
            Guess.union(
                Guess.exact(std.Uint8Array),
                Guess.exact(std.ArrayBuffer),
            ),
            // this is a union of two overloads: (param: InflateFunctionOptions) and (param?: InflateFunctionOptions)
            {
                isAny: false,
                kind: {
                    Undefined: 0.25,
                    Object: 0.75,
                },
                objectShape: InflateFunctionOptions.objectShape,
            },
        ],
        ret: Guess.union(
            Guess.exact(std.Uint8Array),
            Guess.exact(Types.string()),
        ),
        callconv: "Free",
    };

    schema["inflate"] = inflate;
    schema["inflateRaw"] = inflate;
    schema["ungzip"] = inflate;

    const Inflate = mkClass(schema, "Inflate", [
        Guess.union(Guess.exact(Types.undefined()), InflateOptions),
    ]);
    mkMethod(schema, Inflate, "onData", [Data]);
    mkMethod(schema, Inflate, "onEnd", [Guess.exact(Types.number())]);
    mkMethod(
        schema,
        Inflate,
        "push",
        [
            Data,
            Guess.union(
                Guess.undefined(),
                Guess.union(Guess.boolean(), Guess.number()),
            ),
        ],
        Guess.boolean(),
    );

    const Deflate = mkClass(schema, "Deflate", [
        Guess.union(Guess.undefined(), DeflateOptions),
    ]);
    mkMethod(schema, Deflate, "onData", [Data]);
    mkMethod(schema, Deflate, "onEnd", [Guess.number()]);
    mkMethod(
        schema,
        Deflate,
        "push",
        [
            Guess.union(
                Guess.exact(std.Uint8Array),
                Guess.exact(std.ArrayBuffer),
                Guess.string(),
            ),
            Guess.union(
                Guess.undefined(),
                Guess.union(Guess.number(), Guess.boolean()),
            ),
        ],
        Guess.boolean(),
    );

    return schema;
}

function mkMethod(
    schema: Schema,
    cls: Type,
    methodName: string,
    args: TypeGuess[] = [],
    ret = Guess.exact(Types.undefined()),
) {
    const argsWithClass = [Guess.exact(cls), ...args];
    assert(typeof cls !== "string" && "Class" in cls);

    schema[`${cls.Class}.${methodName}`] = {
        args: argsWithClass,
        ret,
        callconv: "Method",
    };
}

function fastXmlParser(): BenchmarkSchemas["fast-xml-parser"] {
    const schema: BenchmarkSchemas["fast-xml-parser"] = {} as any;
    const std = addStd(schema);

    function os() {
        return Guess.optional(Types.string());
    }
    function ob() {
        return Guess.optional(Types.boolean());
    }

    const strnumOptions = Guess.object({
        hex: Guess.boolean(),
        leadingZeros: Guess.boolean(),
        skipLike: Guess.optional(std.RegExp),
        eNotation: Guess.optional(Types.boolean()),
    });

    const X2jOptions = Guess.object({
        preserveOrder: ob(),
        attributeNamePrefix: os(),
        attributesGroupName: Guess.union(
            Guess.undefined(),
            Guess.union(Guess.boolean(), Guess.string()),
        ),
        textNodeName: os(),
        ignoreAttributes: Guess.union(
            Guess.undefined(),
            Guess.union(
                Guess.boolean(),
                Guess.array(
                    Guess.union(Guess.string(), Guess.exact(std.RegExp)),
                ),
            ),
        ),
        removeNSPrefix: ob(),
        allowBooleanAttributes: ob(),
        parseTagValue: ob(),
        parseAttributeValue: ob(),
        trimValues: ob(),
        cdataPropName: Guess.union(
            Guess.undefined(),
            Guess.union(Guess.boolean(), Guess.string()),
        ),
        commentPropName: Guess.union(
            Guess.undefined(),
            Guess.union(Guess.boolean(), Guess.string()),
        ),
        numberParseOptions: Guess.union(Guess.undefined(), strnumOptions),
        stopNodes: Guess.union(Guess.undefined(), Guess.array(Guess.string())),
        unpairedTags: Guess.union(
            Guess.undefined(),
            Guess.array(Guess.string()),
        ),
        alwaysCreateTextNode: ob(),
        processEntities: ob(),
        htmlEntities: ob(),
        ignoreDeclaration: ob(),
        ignorePiTags: ob(),
        transformAttributeName: ob(),
        transformTagName: ob(),
    });

    const XmlBuilderOptions = Guess.object({
        attributeNamePrefix: os(),
        attributesGroupName: Guess.union(
            Guess.undefined(),
            Guess.union(Guess.boolean(), Guess.string()),
        ),
        textNodeName: os(),
        ignoreAttributes: Guess.union(
            Guess.undefined(),
            Guess.union(
                Guess.boolean(),
                Guess.array(
                    Guess.union(Guess.string(), Guess.exact(std.RegExp)),
                ),
            ),
        ),
        cdataPropName: Guess.union(
            Guess.undefined(),
            Guess.union(Guess.boolean(), Guess.string()),
        ),
        commentPropName: Guess.union(
            Guess.undefined(),
            Guess.union(Guess.boolean(), Guess.string()),
        ),
        format: ob(),
        indentBy: os(),
        arrayNodeName: os(),
        suppressEmptyNode: ob(),
        suppressUnpairedNode: ob(),
        suppressBooleanAttributes: ob(),
        preserveOrder: ob(),
        unpairedTags: Guess.union(
            Guess.undefined(),
            Guess.array(Guess.string()),
        ),
        stopNodes: Guess.union(Guess.undefined(), Guess.array(Guess.string())),
        processEntities: ob(),
        oneListGroup: ob(),
    });

    const validationOptions = Guess.object({
        allowBooleanAttributes: ob(),
        unpairedTags: Guess.union(
            Guess.undefined(),
            Guess.array(Guess.string()),
        ),
    });

    const XMLParser = mkClass(schema, "XMLParser", [
        Guess.union(Guess.undefined(), X2jOptions),
    ]);
    mkMethod(
        schema,
        XMLParser,
        "parse",
        [
            Guess.union(Guess.string(), Guess.exact(std.Buffer)),
            Guess.union(
                Guess.undefined(),
                Guess.union(validationOptions, Guess.boolean()),
            ),
        ],
        Guess.any(),
    );
    mkMethod(schema, XMLParser, "addEntity", [Guess.string(), Guess.string()]);

    const XMLBuilder = mkClass(schema, "XMLBuilder", [
        Guess.union(Guess.undefined(), XmlBuilderOptions),
    ]);
    mkMethod(schema, XMLBuilder, "build", [Guess.any()], Guess.any());

    const ValidationError = Guess.object({
        err: Guess.object({
            code: Guess.string(),
            msg: Guess.string(),
            line: Guess.number(),
            col: Guess.number(),
        }),
    });

    schema["XMLValidator.validate"] = {
        args: [
            Guess.string(),
            Guess.union(Guess.undefined(), validationOptions),
        ],
        ret: Guess.union(Guess.boolean(), ValidationError),
        callconv: "Free",
    };

    return schema;
}

function jsYaml(): BenchmarkSchemas["js-yaml"] {
    const schema: BenchmarkSchemas["js-yaml"] = {} as any;
    addStd(schema);

    const TypeConstructorOptions = Guess.object({
        kind: Guess.optional(Types.string()),
        instanceOf: Guess.optional(Types.object({})),
        represent: Guess.optional(Types.object({})),
        defaultStyle: Guess.optional(Types.string()),
        multi: Guess.optional(Types.boolean()),
        styleAliases: Guess.optional(Types.object({})),
    });

    const Type = mkClass(schema, "Type", [
        Guess.string(),
        Guess.union(Guess.undefined(), TypeConstructorOptions),
    ]);

    const SchemaDefinition = Guess.object({
        implicit: Guess.union(
            Guess.undefined(),
            Guess.array(Guess.exact(Type)),
        ),
        explicit: Guess.union(
            Guess.undefined(),
            Guess.array(Guess.exact(Type)),
        ),
    });

    const Schema = mkClass(schema, "Schema", [
        Guess.union(
            SchemaDefinition,
            Guess.array(Guess.exact(Type)),
            Guess.exact(Type),
        ),
    ]);
    mkMethod(
        schema,
        Schema,
        "extend",
        [
            Guess.union(
                SchemaDefinition,
                Guess.array(Guess.exact(Type)),
                Guess.exact(Type),
            ),
        ],
        Guess.exact(Schema),
    );

    const LoadOptions = Guess.object({
        filename: Guess.optional(Types.string()),
        json: Guess.optional(Types.boolean()),
        schema: Guess.optional(Schema),
    });

    const DumpOptions = Guess.object({
        indent: Guess.optional(Types.number()),
        noArrayIndent: Guess.optional(Types.boolean()),
        skipInvalid: Guess.optional(Types.boolean()),
        flowLevel: Guess.optional(Types.number()),
        styles: Guess.optional(Types.object({})),
        schema: Guess.optional(Schema),
        sortKeys: Guess.optional(Types.boolean()),
        lineWidth: Guess.optional(Types.number()),
        noRefs: Guess.optional(Types.boolean()),
        noCompatMode: Guess.optional(Types.boolean()),
        condenseFlow: Guess.optional(Types.boolean()),
        quotingType: Guess.optional(Types.string()), // NOTE: actual type is quotingType?: "'" | "\"" | undefined
        forceQuotes: Guess.optional(Types.boolean()),
    });

    schema["load"] = {
        args: [Guess.string(), Guess.union(Guess.undefined(), LoadOptions)],
        ret: Guess.any(),
        callconv: "Free",
    };

    schema["loadAll"] = {
        args: [
            Guess.string(),
            {
                isAny: false,
                kind: {
                    Undefined: 0.75,
                    Null: 0.25,
                },
            },
            Guess.union(Guess.undefined(), LoadOptions),
        ],
        ret: {
            isAny: false,
            kind: {
                Undefined: 0.5,
                Array: 0.5,
            },
            arrayValueType: Guess.any(),
        },
        callconv: "Free",
    };

    schema["dump"] = {
        args: [Guess.any(), Guess.union(Guess.undefined(), DumpOptions)],
        ret: Guess.string(),
        callconv: "Free",
    };

    const Mark = Guess.object({
        buffer: Guess.string(),
        column: Guess.number(),
        line: Guess.number(),
        name: Guess.string(),
        position: Guess.number(),
        snippet: Guess.string(),
    });

    const YAMLException = mkClass(schema, "YAMLException", [
        Guess.optional(Types.string()),
        Guess.union(Guess.undefined(), Mark),
    ]);
    mkMethod(
        schema,
        YAMLException,
        "toString",
        [Guess.optional(Types.boolean())],
        Guess.string(),
    );

    return schema;
}

function sharp(): BenchmarkSchemas["sharp"] {
    const schema: BenchmarkSchemas["sharp"] = {} as any;
    const std = addStd(schema);

    const SharpOptionsT = Guess.object({
        failOn: Guess.optional(Types.string()),
        failOnError: Guess.optional(Types.boolean()),
        limitInputPixels: Guess.union(
            Guess.exact(Types.number()),
            Guess.exact(Types.boolean()),
            Guess.exact(Types.undefined()),
        ),
        unlimited: Guess.optional(Types.boolean()),
        sequentialRead: Guess.optional(Types.boolean()),
        density: Guess.optional(Types.number()),
        ignoreIcc: Guess.optional(Types.boolean()),
        pages: Guess.optional(Types.number()),
        page: Guess.optional(Types.number()),
        subifd: Guess.optional(Types.number()),
        level: Guess.optional(Types.number()),
        pdfBackground: Guess.optional(Types.string()),
        animated: Guess.optional(Types.boolean()),
    });

    const OptionalSharpOptionsT: TypeGuess = {
        isAny: false,
        kind: {
            Undefined: 0.5,
            Object: 0.5,
        },
        objectShape: SharpOptionsT.objectShape,
    };

    const TrimOptionsT = Guess.object({
        background: Guess.optional(Types.string()),
        threshold: Guess.optional(Types.number()),
        lineArt: Guess.optional(Types.boolean()),
    });

    const FlattenOptionsT = Guess.object({
        background: Guess.optional(Types.string()),
    });

    const ClaheOptionsT = Guess.object({
        width: Guess.exact(Types.number()),
        height: Guess.exact(Types.number()),
        maxSlope: Guess.optional(Types.number()),
    });

    const GifOptionsT = Guess.object({
        reuse: Guess.optional(Types.boolean()),
        progressive: Guess.optional(Types.boolean()),
        colours: Guess.optional(Types.number()),
        colors: Guess.optional(Types.number()),
        effort: Guess.optional(Types.number()),
        dither: Guess.optional(Types.number()),
        interFrameMaxError: Guess.optional(Types.number()),
        interPaletteMaxError: Guess.optional(Types.number()),
    });

    const OptionalGifOptionsT: TypeGuess = {
        isAny: false,
        kind: {
            Undefined: 0.5,
            Object: 0.5,
        },
        objectShape: GifOptionsT.objectShape,
    };

    const WriteableMetadataT = Guess.object({
        density: Guess.optional(Types.number()),
        orientation: Guess.optional(Types.number()),
        icc: Guess.optional(Types.string()),
    });

    const SharpT = Guess.exact(
        mkClass(schema, "Sharp", [
            Guess.exact(std.Uint8Array),
            OptionalSharpOptionsT,
        ]),
    );

    schema["Sharp.removeAlpha"] = {
        args: [SharpT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.ensureAlpha"] = {
        args: [SharpT, Guess.optional(Types.number())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.extractChannel"] = {
        args: [
            SharpT,
            Guess.union(
                Guess.exact(Types.string()),
                Guess.exact(Types.number()),
            ),
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.joinChannel"] = {
        args: [SharpT, Guess.exact(Types.string()), OptionalSharpOptionsT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.grayscale"] = {
        args: [SharpT, Guess.optional(Types.boolean())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.pipelineColorspace"] = {
        args: [SharpT, Guess.optional(Types.string())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.toColorspace"] = {
        args: [SharpT, Guess.optional(Types.string())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.composite"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Array: 1.0,
                },
                arrayValueType: SharpOptionsT,
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.clone"] = {
        args: [SharpT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.keepMetadata"] = {
        args: [SharpT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.rotate"] = {
        args: [SharpT, Guess.optional(Types.number())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.flip"] = {
        args: [SharpT, Guess.optional(Types.boolean())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.flop"] = {
        args: [SharpT, Guess.optional(Types.boolean())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.sharpen"] = {
        args: [
            SharpT,
            Guess.optional(Types.number()),
            Guess.optional(Types.number()),
            Guess.optional(Types.number()),
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.extend"] = {
        args: [SharpT, Guess.exact(Types.number())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.trim"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: TrimOptionsT.objectShape,
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.median"] = {
        args: [SharpT, Guess.exact(Types.number())],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.unflatten"] = {
        args: [SharpT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.flatten"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Boolean: 0.3,
                    Undefined: 0.3,
                    Object: 0.4,
                },
                objectShape: FlattenOptionsT.objectShape,
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.gamma"] = {
        args: [
            SharpT,
            Guess.optional(Types.number()),
            Guess.optional(Types.number()),
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.gif"] = {
        args: [SharpT, OptionalGifOptionsT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.clahe"] = {
        args: [SharpT, ClaheOptionsT],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.withMetadata"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: WriteableMetadataT.objectShape,
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.jpeg"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: {
                    quality: Guess.optional(Types.number()),
                    progressive: Guess.optional(Types.boolean()),
                    chromaSubsampling: Guess.optional(Types.boolean()),
                    mozjpeg: Guess.optional(Types.boolean()),
                    quantizationTable: Guess.optional(Types.number()),
                },
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.png"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: {
                    quality: Guess.optional(Types.number()),
                    compressionLevel: Guess.optional(Types.number()),
                    effort: Guess.optional(Types.number()),
                    dither: Guess.optional(Types.number()),
                    progressive: Guess.optional(Types.boolean()),
                },
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.webp"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: {
                    quality: Guess.optional(Types.number()),
                    effort: Guess.optional(Types.number()),
                    lossless: Guess.optional(Types.boolean()),
                    mixed: Guess.optional(Types.boolean()),
                },
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.tiff"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: {
                    quality: Guess.optional(Types.number()),
                    compression: Guess.optional(Types.string()),
                    pyramid: Guess.optional(Types.boolean()),
                    tile: Guess.optional(Types.boolean()),
                },
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.avif"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Undefined: 0.5,
                    Object: 0.5,
                },
                objectShape: {
                    quality: Guess.optional(Types.number()),
                    effort: Guess.optional(Types.number()),
                    lossless: Guess.optional(Types.boolean()),
                },
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.negate"] = {
        args: [
            SharpT,
            {
                isAny: false,
                kind: {
                    Boolean: 0.3,
                    Undefined: 0.3,
                    Object: 0.4,
                },
                objectShape: {
                    alpha: Guess.optional(Types.boolean()),
                },
            },
        ],
        ret: SharpT,
        callconv: "Method",
    };

    schema["Sharp.resize"] = {
        args: [
            SharpT,
            Guess.optional(Types.number()),
            Guess.optional(Types.number()),
        ],
        ret: SharpT,
        callconv: "Method",
    };

    return schema;
}

function example(): BenchmarkSchemas["example"] {
    const schema = {} as BenchmarkSchemas["example"];
    addStd(schema);

    schema["compress"] = {
        args: [Guess.exact(Types.string()), Guess.exact(Types.number())],
        ret: Guess.exact(Types.string()),
        callconv: "Free",
    };

    schema["decompress"] = {
        args: [Guess.exact(Types.string())],
        ret: Guess.exact(Types.string()),
        callconv: "Free",
    };

    return schema;
}

const schemas: BenchmarkSchemas = {
    pako: pako(),
    "protobuf-js": protobufJs(),
    "fast-xml-parser": fastXmlParser(),
    "js-yaml": jsYaml(),
    sharp: sharp(),
    example: example(),
};

export default schemas;
