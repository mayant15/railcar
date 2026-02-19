import {
    AbstractSyntaxTreeFactory,
    TypeExtractor,
    InferenceTypeModelFactory,
    ExportFactory,
    TypeEnum,
    Export,
    Relation,
    Element,
} from "@syntest/analysis-javascript";
import { unwrap, Result } from "@syntest/diagnostics";
import * as t from "@babel/types";
import { setupLogger } from "@syntest/logging";
import { exit } from "process";
import * as fs from "fs";
import { transform, addLocationReturn } from "./program-transform.js";
import { TypeNode } from "@syntest/analysis-javascript/dist/lib/type/resolving/TypeNode.js";
import { loadSchema } from "./reflection.js";
import { Endpoints } from "./schema.js";
import type { Schema } from "./schema.js";
import _generate from "@babel/generator";
export const generate =
    typeof _generate === "function"
        ? _generate
        : // @ts-ignore
          _generate.default;
import _traverse from "@babel/traverse";
export const traverse =
    typeof _traverse === "function"
        ? _traverse
        : // @ts-ignore
          _traverse.default;
import { NodePath, TraverseOptions } from "@babel/traverse";
import AhoCorasick from "ahocorasick";

const SYNTAX_FROGIVING = true;
const typeExtractor = new TypeExtractor(SYNTAX_FROGIVING); // syntaxForgiving??

export interface CustomExport {
    id: string;
    name: string;
    renamedTo: string;
    probabilities?:
        | {
              [k: string]: number;
          }
        | null
        | undefined;
    root?: string | null | undefined;
    startIndex?: number;
    endIndex?: number;
}

interface CustomEndpoints {
    [x: string]: {
        fn: (...args: unknown[]) => unknown;
        id: string;
    };
}

const allTypeValues: TypeEnum[] = Object.values(TypeEnum);
setupLogger("", [], "debug");

const getId = (node: t.Node): string => {
    if (!node.loc) return "";
    const { start, end } = node.loc;
    return `:${start.line}:${start.column}:::${end.line}:${end.column}:::${node.start}:${node.end}`;
};

function getAllFunctions(source: t.Node): CustomExport[] {
    let result: CustomExport[] = [];

    // Traverse AST manually
    const visit = (node: t.Node) => {
        if (
            t.isFunctionDeclaration(node) ||
            t.isFunctionExpression(node) ||
            t.isArrowFunctionExpression(node)
        ) {
            let name = "anonymous";
            if ("id" in node && node.id && t.isIdentifier(node.id)) {
                name = node.id.name;
            } else {
                // console.log({
                //   'anon': generate(node).code
                // })
            }

            result.push({
                id: getId(node),
                name,
                startIndex: node.start as number,
                endIndex: node.end as number,
                renamedTo: name,
            });
        }

        // Recursively visit child nodes
        for (const key of Object.keys(node)) {
            const value = (node as any)[key];
            if (Array.isArray(value)) {
                value.forEach((child) => {
                    if (child && typeof child.type === "string") visit(child);
                });
            } else if (value && typeof value.type === "string") {
                visit(value);
            }
        }
    };

    visit(source);
    return result;
}

export interface MethodInfo extends CustomExport {
    id: string;
    name: string;
    renamedTo: string;
    className: string;
}

function analyizeAllClasses(source: t.Node): Record<string, MethodInfo> {
    const result: Record<string, MethodInfo> = {};

    const visitor: TraverseOptions<t.Node> = {
        Class(path: NodePath<t.ClassDeclaration | t.ClassExpression>) {
            const classNode = path.node;

            for (const element of classNode.body.body) {
                // -------- 1. class foo { method() {} } ----------
                if (t.isClassMethod(element)) {
                    const id = getId(element);

                    const name = t.isIdentifier(element.key)
                        ? element.key.name
                        : t.isStringLiteral(element.key)
                          ? element.key.value
                          : "<computed>";

                    result[id] = {
                        id,
                        renamedTo: `${classNode.id?.name}.${name}`,
                        name: name,
                        className: classNode.id?.name ?? "",
                    };
                }

                // // -------- 2. class foo { #private() {} } ----------
                // if (t.isClassPrivateMethod(element)) {
                //   const id = getId(element);
                //   const name = element.key.id.name;
                //   result[id] = { id, name };
                // }

                // -------- 3. class foo { prop = () => {} } ----------
                if (
                    t.isClassProperty(element) ||
                    t.isClassPrivateProperty(element)
                ) {
                    if (
                        t.isFunction(element.value) ||
                        t.isArrowFunctionExpression(element.value)
                    ) {
                        const id = getId(element);

                        // property keys can be identifier, string literal, numeric, computed, etc.
                        const key = element.key;

                        const name = t.isIdentifier(key)
                            ? key.name
                            : t.isStringLiteral(key)
                              ? key.value
                              : "<computed>";

                        result[id] = {
                            id,
                            renamedTo: `${classNode.id?.name}.${name}`,
                            name: name,
                            className: classNode.id?.name ?? "",
                        };
                    }
                }
            }
        },
    };

    traverse(source, visitor);
    return result;
}

function indexToLineCol(source: string, index: number) {
    const upToIndex = source.slice(0, index);
    const lines = upToIndex.split("\n");

    const line = lines.length; // 1-based line number
    const column = lines[lines.length - 1].length; // 0-based column
    return { line, column };
}

function mapToCustomEnpoints(endpoints: Endpoints): CustomEndpoints {
    const custom: CustomEndpoints = {};

    for (const [name, fn] of Object.entries(endpoints)) {
        custom[name] = {
            fn,
            id: "",
        };
    }

    return custom;
}

/**
 * 
 * @param fileName entrypoint (library file name, often bundled)
 * @param benchmarkTypescriptJSONPath typescript.json path whose keys are the only concerning keys you want to test
 * @returns 
 */
export async function syntestSchema(fileName: string, benchmarkTypescriptJSONPath: string = "") {
    const filePath = "";
    const readSrc = fs.readFileSync(fileName, "utf8");
    const source = transform(readSrc, fileName + ".transformed.js");
    const typescriptContent = benchmarkTypescriptJSONPath === "" ? "{}" : fs.readFileSync(benchmarkTypescriptJSONPath, "utf8");
    const typeScriptJSON = JSON.parse(typescriptContent);
    const interestedKeys = Object.keys(typeScriptJSON);
    // const prototype = addLocationReturn(source);
    // fs.writeFileSync('prototype.js', prototype);

    // const transformedAfterRewrite = bundleFile(fileName);
    // console.log(transformedAfterRewrite);
    // const lines = source.split(/\r?\n/);
    // const exportFactory = new ExportFactory(SYNTAX_FROGIVING);
    // Get ast
    const generator = new AbstractSyntaxTreeFactory();
    const result: Result<t.Node> = generator.convert(filePath, source);
    if (!result.success) {
        return {};
    }
    console.log("Generated AST");
    const astUnwrapped = unwrap(result);
    console.log('unwrapped result');

    // get ALL functions:
    // const allFunctions = getAllFunctions(astUnwrapped);
    // const allClassMethods = analyizeAllClasses(astUnwrapped);
    // fs.writeFileSync('./allClasses.json', JSON.stringify(allClassMethods, null, 2));
    // re-assign names to functions that are exported (discovered from dynamic analysis)
    const dynamicAnalysis = await loadSchema(fileName + ".transformed.js", {
        'methodsToSkip': [
            'sys.exit', 'sys.clearScreen'
        ]
    });
    console.log('loaded schema');
    const dynamicSchema = interestedKeys.length === 0 ? dynamicAnalysis.schema : Object.fromEntries(
        Object.entries(dynamicAnalysis.schema).filter(([k]) => 
            interestedKeys.includes(k as any)
        )
    );

    const dynamicEndpoints: CustomEndpoints = mapToCustomEnpoints(
        dynamicAnalysis.endpoints,
    );
    console.log(
        `There are ${Object.entries(dynamicEndpoints).length} dynamic endpoints. Source code length is: ${source.length}`,
    );
    if (benchmarkTypescriptJSONPath !== "") {
        console.log(
            `benchmarkTypescriptJSONPath was passed, there are ${Object.entries(dynamicSchema).length} interested endpoints.`,
        );
    }

    const patternToKey = new Map();
    const patterns = Object.entries(dynamicEndpoints).map(([key, value]) => {
        const pattern = value.fn.toString();
        if (pattern) {
            patternToKey.set(pattern, key);
            return pattern;
        } else {
            return key; // lodash: lodash._ returns error
        }
    });
    const ahoCorasickPatterns = new AhoCorasick(patterns);
    console.log(`Loaded ahoCorasickPatterns`);
    const searchResults = ahoCorasickPatterns.search(source);
    const firstIndex = new Map();
    for (const [endIndex, matchedList] of searchResults) {
        for (const pattern of matchedList) {
            if (firstIndex.has(pattern)) continue;
            const startIndex = endIndex - pattern.length + 1;
            firstIndex.set(pattern, startIndex);
        }
    }
    let cnt = 0;
    for (const [key, endpoint] of Object.entries(dynamicEndpoints)) {
        const pat = endpoint.fn.toString();
        const startIndex = firstIndex.get(pat);
        if (startIndex == null) {
            continue;
        } // no match
        const endIndex = startIndex + pat.length;
        const start = indexToLineCol(source, startIndex);
        const end = indexToLineCol(source, endIndex);
        endpoint.id = `:${start.line}:${start.column}:::${end.line}:${end.column}:::${startIndex}:${endIndex}`;
        // console.log({
        //     'endpoint': pat,
        //     'id': endpoint.id
        // })
        cnt += 1;
    }
    console.log("indexed ", cnt, " endpoints from dynamic (this is irrelevant benchmarkTypescriptJSON)");
    console.log("Done mapping all dynamic entrypoints with static ids");
    // get elements & relations
    const elementsResult: Result<Map<string, Element>> =
        typeExtractor.extractElements(filePath, astUnwrapped);
    if (!elementsResult.success) {
        return {};
    }
    console.log("Had all elements from AST");
    const relationsResult: Result<Map<string, Relation>> =
        typeExtractor.extractRelations(filePath, astUnwrapped);
    if (!relationsResult.success) {
        return {};
    }
    // get Type Model
    const typeResolver = new InferenceTypeModelFactory();
    const typeModel = typeResolver.resolveTypes(
        elementsResult.result,
        relationsResult.result,
    );
    console.log("Resolved type between elements and relations");
    // @ts-ignore
    globalThis.relationsResult = relationsResult;
    // @ts-ignore
    globalThis.elementsResult = elementsResult;
    // @ts-ignore
    globalThis.typeModel = typeModel;

    const reg = /^:(\d+):(\d+):::(\d+):(\d+):::(\d+):(\d+)(.*)$/;

    let schemaJson: any = {};
    let idMap = new Map();
    let objIdMap = new Map();
    let objIdMapCircularDetector = new Map();

    function getTypeFromOriginalType(type: string) {
        for (const t of allTypeValues) {
            if (type.includes(t)) {
                return t;
            }
        }
        return type;
    }

    /** return a json like mapping of name => type */
    function getObjectSchema(id: string) {
        if (objIdMap.get(id)) {
            return objIdMap.get(id);
        }
        if (objIdMapCircularDetector.get(id)) {
            return {};
        }
        objIdMapCircularDetector.set(id, {});
        let objSchema: any = {};
        const node = typeModel.getTypeNode(id);
        const objProperties = node.objectType.properties;
        // @ts-ignore
        Array.from(objProperties.entries()).forEach(([key, value]) => {
            objSchema[key] = getSchemaFromId(value, key);
        });
        objIdMap.set(id, objSchema);
        return objSchema;
    }

    function capitalizeObjectKeys(obj: any) {
        return Object.fromEntries(
            Object.entries(obj).map(([key, value]) => {
                const capitalizedKey =
                    key.charAt(0).toUpperCase() + key.slice(1);
                return [capitalizedKey, value];
            }),
        );
    }

    function removeObjFields0(obj: any) {
        return Object.fromEntries(
            Object.entries(obj).filter(([_, value]) => value !== 0),
        );
    }

    function mergeObjectShapes(shapes: any) {
        const merged: any = {};

        for (const shape of shapes) {
            for (const [key, value] of Object.entries(shape)) {
                if (!merged[key]) {
                    merged[key] = JSON.parse(JSON.stringify(value));
                } else {
                    const v: any = value;
                    const kindMap = merged[key].kind || {};
                    const newKind = v.kind || {};
                    for (const [k, v] of Object.entries(newKind)) {
                        kindMap[k] = (kindMap[k] || 0) + v;
                    }
                    merged[key].kind = kindMap;

                    if (v.objectShape && v.objectShape.length > 0) {
                        const deepObjShape = mergeObjectShapes([
                            ...(merged[key].objectShape || []),
                            ...v.objectShape,
                        ]);
                        merged[key].objectShape = deepObjShape;
                    }
                    merged[key].arrayValueType = v.arrayValueType ?? {
                        isAny: true,
                        kind: {},
                    };
                }
            }
        }

        // Normalize kinds
        for (const key in merged) {
            const kind = merged[key].kind;
            if (!kind) {
                continue;
            }
            const total: any | number = Object.values(kind).reduce(
                (a: any, b: any) => a + b,
                0,
            );
            if (total !== 0) {
                for (const k in kind) {
                    kind[k] = kind[k] / total;
                }
            }
        }

        return merged;
    }

    function idReduction(id: string): string | null {
        const match = id.match(/^(:\d+:\d+:::\d+:\d+:::\d+:\d+)$/);
        return match ? match[1] : null;
    }

    function getSchemaFromId(_id: string, name: string) {
        const id = idReduction(_id);
        if (id == null) {
            return {
                isAny: true,
                kind: {},
            };
        }
        if (idMap.get(id)) {
            return idMap.get(id);
        }
        // console.log(_id, " ==> ", id);
        const node = typeModel.getTypeNode(id);
        const typeProbs = node.getTypeProbabilities();
        const types = [...typeProbs.keys()];
        let typesJson: any = Object.fromEntries(
            allTypeValues.map((type) => [type, 0]),
        );
        let originalKindJson: any = {};
        let objectType = [];
        let hasType = false;
        let concreteObject = false;
        let couldBeArray = false;
        for (const type of types) {
            const t = getTypeFromOriginalType(type);
            typesJson[t] += typeProbs.get(type);
            originalKindJson[type] = typeProbs.get(type);
            if (type.includes("object")) {
                if (type !== "object") {
                    // @ts-ignore
                    const match = type.match(reg);
                    if (!match) {
                        continue;
                    }
                    const [
                        ,
                        startRow,
                        startCol,
                        endRow,
                        endCol,
                        startInd,
                        endInd,
                        ,
                    ] = match;
                    objectType.push(
                        getObjectSchema(
                            `:${startRow}:${startCol}:::${endRow}:${endCol}:::${startInd}:${endInd}`,
                        ),
                    );
                } else {
                    concreteObject = true;
                }
            }

            if (type.includes("array")) {
                couldBeArray = true;
            }
            hasType = true;
        }
        typesJson["number"] = typesJson["numeric"] + typesJson["integer"];
        typesJson["numeric"] = 0;
        typesJson["integer"] = 0;
        if (hasType) {
            typesJson = removeObjFields0(typesJson);
            typesJson = capitalizeObjectKeys(typesJson);
        }
        if (concreteObject) {
            objectType.push(getObjectSchema(id));
            // let cntObjectProperties = 0;
            // const objProperties = node._objectType.properties
            // objProperties.entries().forEach(entry => {
            //   console.log("GOING INTO: ", entry)
            //   objectType.push(getSchemaFromId(entry[1], entry[0]))
            //   cntObjectProperties += 1
            // })
            // if (cntObjectProperties == 1) {
            //   objectType = objectType[0]
            // }
        }
        objectType = objectType.filter((obj) => Object.keys(obj).length !== 0);
        const mergedObjShapes = mergeObjectShapes(objectType);
        let result: any = {};
        result.isAny = !hasType;
        result.kind = hasType ? typesJson : {};
        if (!isEmptyObject(mergedObjShapes)) {
            result.objectShape = mergedObjShapes;
        } else {
            result.objectShape = {};
        }
        if (couldBeArray) {
            result.arrayValueType = {
                isAny: true,
                kind: {},
            };
        }
        idMap.set(id, result);
        return result;
    }

    function mergeRet(ret: any[]) {
        if (!Array.isArray(ret)) {
            return ret;
        }
        if (ret.length <= 1) {
            return ret[0];
        }

        let objShapes = [];

        const mergedKind: any = {};
        let totProbabilities: number = 0;

        for (const obj of ret) {
            for (const [key, value] of Object.entries(obj.kind)) {
                mergedKind[key] = (mergedKind[key] || 0) + value;
                totProbabilities += value as number;
            }
            if (obj.objectShape && !isEmptyObject(obj.objectShape)) {
                objShapes.push(obj.objectShape);
            }
        }

        const normalizedKind: any = {};
        for (const [key, value] of Object.entries(mergedKind)) {
            normalizedKind[key] = (value as number) / totProbabilities;
        }

        const mergedObjShapes = mergeObjectShapes(objShapes);

        return {
            isAny: false,
            kind: normalizedKind,
            objectShape: mergedObjShapes,
            arrayValueType: {
                isAny: true,
                kind: {},
            },
        };
    }

    function isEmptyObject(obj: any) {
        return Object.keys(obj).length === 0;
    }

    function getSchemaFromIds(
        ids: string[] = [],
        names: string[] | null = null,
    ): any[] {
        let result = [];
        for (const i in ids) {
            const id = ids[i];
            const name = names ? names[i] : "not_specified";
            let schema = {};

            try {
                schema = getSchemaFromId(id, name)
            } catch (err) {
                console.log('Cannot get Schema from ', id, name, 'skipping');
            }
            if (!isEmptyObject(schema)) {
                result.push(schema);
            }
        }
        return result;
    }

    const startUnixTimeStamp = Math.floor(Date.now() / 1000);
    cnt = 0;
    let unidentifiable: String[] = []
    const tot = Object.entries(dynamicSchema).filter(
        ([entry, sig]) => dynamicEndpoints[entry].id != "",
    ).length;
    Object.entries(dynamicSchema).forEach(([entry, sig]) => {
        if (dynamicEndpoints[entry].id == "") {
            unidentifiable.push(entry)
        }
    })
    const totDynamicSchema = Object.entries(dynamicSchema).length;
    console.log('Out of', totDynamicSchema, 'endpoints, Syntest can only find', tot, 'with identifiable ids, the rest will be using random any instead')
    if (tot < totDynamicSchema) {
        console.log('Unidentifiable entries: ', unidentifiable.toString())
    }

    Object.entries(dynamicSchema).forEach(([entryPoint, sig]) => {
        if (Math.floor(Date.now() / 1000) - startUnixTimeStamp > 120) {
            return;
        }

        const id = dynamicEndpoints[entryPoint].id;
        if (id != "") {
            if (sig.callconv == "Free") {
                let func = null;
                try {
                    func = typeModel.getTypeNode(id).objectType;
                } catch (anyErr) {
                    return;
                }
                const retType = getSchemaFromIds([...func.return.values()]);
                const args = getSchemaFromIds(
                    [...func.parameters.values()],
                    [...func.parameterNames.values()],
                );
                const ret = isEmptyObject(retType)
                    ? {
                          isAny: true,
                          kind: {},
                      }
                    : mergeRet(retType);
                ret.objectShape = ret.objectShape ?? {};
                dynamicSchema[entryPoint].args = args;
                dynamicSchema[entryPoint].ret = ret;
            } else {
                const node = relationsResult.result.get(id);
                const involved = node?.involved ?? [];
                const argIds = involved.slice(1);
                const methodArgs = getSchemaFromIds(argIds);

                // @ts-ignore
                if (sig.args[0] == null) {
                    dynamicSchema[entryPoint].args = [
                        {
                            isAny: false,
                            kind: {
                                Array: 1,
                            },
                            arrayValueType: {
                                isAny: true,
                                kind: {},
                            },
                        },
                    ];
                } else {
                    dynamicSchema[entryPoint].args = [
                        sig.args[0],
                        ...methodArgs,
                    ];
                }
            }

            cnt += 1;
            if (cnt % 10 == 0) {
                console.log("processed ", cnt, "/", tot);
            }
        }
    });
    if (cnt < tot) {
        console.log(
            "ran for 3 min, stopping, producing partial result, processed ",
            cnt,
            " IDs",
        );
    } else {
        console.log("processed all", tot, " IDs");
    }
    for (const key of Object.keys(dynamicSchema)) {
        if (key.startsWith("default.")) {
            delete dynamicSchema[key];
        }
    }

    return dynamicSchema;
}
