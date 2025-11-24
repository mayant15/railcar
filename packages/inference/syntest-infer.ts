import { AbstractSyntaxTreeFactory, TypeExtractor, InferenceTypeModelFactory,ExportFactory, TypeEnum, Export, Relation, Element } from "@syntest/analysis-javascript";
import { unwrap, Result } from "@syntest/diagnostics";
import * as t from "@babel/types";
import { setupLogger } from "@syntest/logging";
import { exit } from "process";
import * as fs from "fs";
import { transform, bundleFile } from "./program-transform.js";
import { TypeNode } from "@syntest/analysis-javascript/dist/lib/type/resolving/TypeNode.js";
import { loadSchema } from "./reflection.js";
import type { Schema } from "./schema.js";
import _generate from "@babel/generator";
export const generate = typeof _generate === "function" ? _generate 
  // @ts-ignore
  : _generate.default
import _traverse from "@babel/traverse";
export const traverse = typeof _traverse === "function" ? _traverse 
  // @ts-ignore
  : _traverse.default
import { NodePath, TraverseOptions } from "@babel/traverse"

const SYNTAX_FROGIVING = true;
const typeExtractor = new TypeExtractor(SYNTAX_FROGIVING); // syntaxForgiving??

export interface CustomExport {
  id: string;
  name: string;
  renamedTo: string;
  probabilities?: {
      [k: string]: number;
  }|null|undefined,
  root?: string|null|undefined;
}

const allTypeValues: TypeEnum[] = Object.values(TypeEnum);
setupLogger("", [], "debug");

const getId = (node: t.Node): string => {
  if (!node.loc) return "";
  const { start, end } = node.loc;
  return `:${start.line}:${start.column}:::${end.line}:${end.column}:::${node.start}:${node.end}`;
};

function getAllFunctions(source: t.Node): CustomExport[] {
  let result: CustomExport[] = []
  
  // Traverse AST manually
  const visit = (node: t.Node) => {
    if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
      let name = "anonymous";
      if ("id" in node && node.id && t.isIdentifier(node.id)) {
        name = node.id.name;
      } else {
        console.log({
          'anon': generate(node).code
        })
      }

      result.push({
        id: getId(node),
        name,
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

function isMethodInfo(obj: CustomExport | MethodInfo): obj is MethodInfo {
  return (
    obj !== null &&
    "className" in obj 
  );
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

          const name =
            t.isIdentifier(element.key) ? element.key.name :
            t.isStringLiteral(element.key) ? element.key.value :
            "<computed>";

          result[id] = { 
            id, 
            renamedTo: `${classNode.id?.name}.${name}`, 
            name: name,
            className: classNode.id?.name ?? ""
          };
        }

        // // -------- 2. class foo { #private() {} } ----------
        // if (t.isClassPrivateMethod(element)) {
        //   const id = getId(element);
        //   const name = element.key.id.name;
        //   result[id] = { id, name };
        // }

        // -------- 3. class foo { prop = () => {} } ----------
        if (t.isClassProperty(element) || t.isClassPrivateProperty(element)) {
          if (
            t.isFunction(element.value) ||
            t.isArrowFunctionExpression(element.value)
          ) {
            const id = getId(element);

            // property keys can be identifier, string literal, numeric, computed, etc.
            const key = element.key;

            const name =
              t.isIdentifier(key) ? key.name :
              t.isStringLiteral(key) ? key.value :
              "<computed>";

            result[id] = { 
              id, 
              renamedTo: `${classNode.id?.name}.${name}`, 
              name: name,
              className: classNode.id?.name ?? ""
            };
          }
        }
      }
    },
  };

  traverse(source, visitor);
  return result;
}

export async function syntestSchema(fileName: string, schemeAllFunction: Boolean = false) {
  const filePath = "";
  const readSrc = fs.readFileSync(fileName, "utf8");
  const source = transform(readSrc, fileName + ".transformed.js");
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
  console.log('Generated AST')
  const astUnwrapped = unwrap(result);
  // get ALL functions:
  const allFunctions = getAllFunctions(astUnwrapped);
  const allClassMethods = analyizeAllClasses(astUnwrapped);
  // fs.writeFileSync('./allClasses.json', JSON.stringify(allClassMethods, null, 2));
  // re-assign names to functions that are exported (discovered from dynamic analysis)
  const dynamicAnalysis = (await loadSchema(fileName + ".transformed.js"))
  const dynamicSchema = dynamicAnalysis.schema;
  const validNames = new Set(
    Object.values(dynamicAnalysis.endpoints).map(fnObj => fnObj.name).filter((name:string) => name !== "Buffer")
  )

  const filteredFunctions = allFunctions
    .filter(func => schemeAllFunction ? true : validNames.has(func.name))
    .map(func => {
      for (const key of Object.keys(dynamicAnalysis.endpoints)) {
        const endpointFuncName =  dynamicAnalysis.endpoints[key].name;
        if (dynamicSchema[key].callconv == "Free" && func.name === endpointFuncName) {
          return { ...func, renamedTo: key };
        }
      }
    return func; 
  });


  // fs.writeFileSync('./allFunctions.json', JSON.stringify(filteredFunctions, null, 2));
  // fs.writeFileSync('./allEndpoints.json', JSON.stringify(Object.keys(dynamicAnalysis.endpoints).map((k: any) => [k, dynamicAnalysis.endpoints[k].name, dynamicSchema[k].callconv]), null, 2));
  // Get exported functions
  // libraries/analysis-javascript/lib/target/export/ExportFactory.ts
  // const exportResult: Result<Export[]> = exportFactory.extract(filePath, astUnwrapped);
  // if (!exportResult.success) {
  //   return {};
  // }
  // console.log('Secured all exports from AST')
  // const exportedFunctions: CustomExport[] = exportResult.result;

  // get elements & relations
  const elementsResult: Result<Map<string, Element>>  = typeExtractor.extractElements(filePath, astUnwrapped);
  if (!elementsResult.success) {
    return {};
  }
  console.log('Had all elements from AST')
  const relationsResult: Result<Map<string, Relation>> = typeExtractor.extractRelations(
    filePath,
    astUnwrapped
  );
  if (!relationsResult.success) {
    return {};
  }
  // get Type Model
  const typeResolver = new InferenceTypeModelFactory();
  const typeModel = typeResolver.resolveTypes(
    elementsResult.result,
    relationsResult.result
  );
  console.log('Resolved type between elements and relations')
  // @ts-ignore
  globalThis.relationsResult = relationsResult
  // @ts-ignore
  globalThis.elementsResult = elementsResult
  // @ts-ignore
  globalThis.typeModel = typeModel

  // REALLY COMPUTATIONALLY EXPENSIVE IN LARGE PROJECT
  typeModel.typeNodes.forEach((value: TypeNode, key: string) => {
    try {
      value.getTypeProbabilities();
    } catch (e) {
      console.log("It's ", value.id, " that fails")
      exit(0);
    }
  });

  console.log('Calculated all probabilities')

  const reg = /^:(\d+):(\d+):::(\d+):(\d+):::(\d+):(\d+)(.*)$/;

  let schemaJson: any = {};
  let idMap = new Map()
  let objIdMap = new Map()
  let objIdMapCircularDetector = new Map();

  function getTypeFromOriginalType(type: string) {
    for (const t of allTypeValues) {
      if (type.includes(t)) {
        return t;
      }
    }
    return type
  }

  /** return a json like mapping of name => type */
  function getObjectSchema(id: string) {
    if (objIdMap.get(id)) {
      return objIdMap.get(id)
    }
    if (objIdMapCircularDetector.get(id)) {
      return {};
    }
    objIdMapCircularDetector.set(id, {})
    let objSchema: any = {}
    const node = typeModel.getTypeNode(id)
    const objProperties = node.objectType.properties
    // @ts-ignore
    Array.from(objProperties.entries()).forEach(([key, value]) => {
      objSchema[key] = getSchemaFromId(value, key);
    });
    objIdMap.set(id, objSchema);
    return objSchema
  }

  function capitalizeObjectKeys(obj: any) {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => {
        const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
        return [capitalizedKey, value];
      })
    );
  }

  function removeObjFields0(obj: any) {
    return Object.fromEntries(
      Object.entries(obj).filter(([_, value]) => value !== 0)
    )
  }

  function mergeObjectShapes(shapes: any) {
    const merged: any = {};

    for (const shape of shapes) {
      for (const [key, value] of Object.entries(shape)) {
        if (!merged[key]) {
          merged[key] = JSON.parse(JSON.stringify(value)); 
        } else {
          const v: any = value
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
            merged[key].objectShape = deepObjShape
          }
          merged[key].arrayValueType = v.arrayValueType ?? {
            "isAny": true,
            "kind": {}
          }
        }
      }
    }

    // Normalize kinds
    for (const key in merged) {
      const kind = merged[key].kind;
      if (!kind) {
        continue;
      }
      const total: any|number = Object.values(kind).reduce((a: any, b: any) => a + b, 0);
      if (total !== 0) {
        for (const k in kind) {
          kind[k] = kind[k] / total;
        }
      }
    }

    return merged;
  }
    

  function getSchemaFromId(id: string, name: string) {
    if (idMap.get(id)) {
      return idMap.get(id)
    } 
    const node = typeModel.getTypeNode(id);
    const typeProbs = node.getTypeProbabilities();
    const types = [...typeProbs.keys()];
    let typesJson: any = Object.fromEntries(allTypeValues.map(type => [type, 0]))
    let originalKindJson: any = {};
    let objectType = [] 
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
          const match = type.match(reg)
          if (!match) {
            continue;
          }
          const [,startRow,startCol,endRow,endCol,startInd,endInd,,] = match
          objectType.push(getObjectSchema(`:${startRow}:${startCol}:::${endRow}:${endCol}:::${startInd}:${endInd}`))
        } else {
          concreteObject = true
        }
      }

      if (type.includes("array")) {
        couldBeArray = true;
      }
      hasType = true;
    }
    typesJson['number'] = typesJson['numeric'] + typesJson['integer']
    typesJson['numeric'] = 0
    typesJson['integer'] = 0
    if (hasType) {
      typesJson = removeObjFields0(typesJson)
      typesJson = capitalizeObjectKeys(typesJson)
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
    objectType = objectType.filter(obj => Object.keys(obj).length !== 0);
    const mergedObjShapes = mergeObjectShapes(objectType)
    let result: any = {}
    result.isAny = !hasType
    result.kind = hasType ? typesJson : {}
    if (!isEmptyObject(mergedObjShapes)) {
      result.objectShape = mergedObjShapes
    } else {
      result.objectShape = {}
    }
    if (couldBeArray) {
      result.arrayValueType = {
        "isAny": true,
        "kind": {}
      }
    }
    idMap.set(id, result);
    return result
  }

  function mergeRet(ret: any[]) {
    if (!Array.isArray(ret)) {
      return ret;
    } 
    if (ret.length <= 1) {
      return ret[0];
    }

    let objShapes = []

    const mergedKind:any = {};
    let totProbabilities: number = 0;

    for (const obj of ret) {
      for (const [key, value] of Object.entries(obj.kind)) {
        mergedKind[key] = (mergedKind[key] || 0) + value;
        totProbabilities += value as number;
      }
      if (!isEmptyObject(obj.objectShape)) {
        objShapes.push(obj.objectShape)
      }
    }

    const normalizedKind: any = {};
    for (const [key, value] of Object.entries(mergedKind)) {
      normalizedKind[key] = (value as number) / totProbabilities;
    }

    const mergedObjShapes = mergeObjectShapes(objShapes)

    return {
      isAny: false,
      kind: normalizedKind,
      objectShape: mergedObjShapes,
      arrayValueType: {
            "isAny": true,
            "kind": {}
          }
    };
  }

  function isEmptyObject(obj: any) {
    return Object.keys(obj).length === 0;
  }

  function getSchemaFromIds(ids: string[] = [], names: string[]|null = null):any[] {
    let result = [];
    for (const i in ids) {
      const id = ids[i];
      const name = names ? names[i] : "not_specified";
      const schema = getSchemaFromId(id, name)
      if (!isEmptyObject(schema)) {
        result.push(schema)
      }
    }
    return result;
  }

  const functionsToBeExplored = [...filteredFunctions]

  /**
   * functionToBeExplored has id, this method add root & probabilities
   */
  function traceBackFunctionId(
    functionToBeExplored: CustomExport|MethodInfo, 
    relationsResult: Result<Map<string, Relation>>,
    elementsResult: Result<Map<string, Element>>
  ): CustomExport|MethodInfo {
    let fid: string = functionToBeExplored.id;
    let res: CustomExport|MethodInfo = functionToBeExplored;
    if (!relationsResult.success || !elementsResult.success) {
      res.probabilities = {};
      res.root = null;
      return res;
    } 
    console.log('processing fid: ', fid)
    let node: null|Relation|Element|undefined = null;
    let targetID: string|null = null;
    let targetProb = null;
    /** Trace back to the function */
    do {
      node = relationsResult.result.get(fid);

      if (node !== undefined) {
        const typeNode = typeModel.getTypeNode(fid);
        const probs = Object.fromEntries(typeNode.getTypeProbabilities());

        if (node.type != "L=R") {
          if (node.type == 'function L(R)') {
            res.probabilities = probs;
            res.root = fid
          } else {
            // save
            res.probabilities = targetProb;
            res.root = targetID;
          }
          break;
        }
        fid = node.involved[1];
        targetID = fid;
        targetProb = probs;
      } else {
        node = elementsResult.result.get(fid);
        // console.log(`fid - ${fid} - is element, getting element's bindingId now`)
        if (node !== undefined && node.bindingId !== fid) {
          fid = node.bindingId;
        } else {
          break;
        }
      }
    } while (node !== null && node !== undefined);

    return res;
  }

  function updateSchemaFromTracedFunction(tracedFunction: CustomExport, schemaJson: any = {}) {
    for (const key in tracedFunction.probabilities) {
      if (key.includes("function")) {
        const match = key.match(reg) === null ? tracedFunction.root?.match(reg) : key.match(reg)
        // @ts-ignore
        const [,startLine,startColumn,endLine,endColum,startIndex,endIndex,] = match;
        const id = `:${startLine}:${startColumn}:::${endLine}:${endColum}:::${startIndex}:${endIndex}`;
        const func = typeModel.getTypeNode(id).objectType;
        const retType = getSchemaFromIds([...func.return.values()])
        if (schemaJson[tracedFunction["renamedTo"]] === undefined) {
          schemaJson[tracedFunction["renamedTo"]] = {
          // id: id,
          callconv: "Free",
          args: getSchemaFromIds(
            [...func.parameters.values()],
            [...func.parameterNames.values()]
          ),
          ret: isEmptyObject(retType) ? {
            "isAny": true,
            "kind": {}
          } : mergeRet(retType),
        };
        }
        break;
      }
    }
    return schemaJson;
  }

  for (const index in functionsToBeExplored) {
    let fid: string = functionsToBeExplored[index].id;
    if (fid === undefined) {
      continue;
    } else {
      const tracedFunction: CustomExport = traceBackFunctionId(functionsToBeExplored[index], relationsResult, elementsResult);
      schemaJson = updateSchemaFromTracedFunction(tracedFunction, schemaJson);
    }
  }

  console.log("ARE YOU DONE WITH EXPORTED ??? What's going on")
  for (const med of Object.values(allClassMethods)) {
    if (med.id === undefined) {
      continue;
    } else {
      if (!schemeAllFunction) {
        if (!validNames.has(med.name)) {
          continue;
        }
      }
      const node = relationsResult.result.get(med.id);
      let keyToBeModified = med["renamedTo"];
      if (med.name === 'constructor') {
        keyToBeModified = med.className
      }
      const methodArgs = getSchemaFromIds(node?.involved.slice(2));
      const classType:any = {}
      classType[`${med.className}`] = 1
      const args = [
            {
              "isAny": false,
              "kind": {
                "Class": 1
              },
              "classType": classType
            },
            ...methodArgs
      ]

      if (schemaJson[keyToBeModified] === undefined) {
        schemaJson[keyToBeModified] = {
          callconv: "Method",
          args,
          ret: {
            "isAny": true,
            "kind": {}
          }
        };
      }
    }
  }

  /**
   [
    "default.Deflate", <-- k
    "Deflate$1", <-- dynamicAnalysis.endpoints[k].name
    "Constructor" <-- dynamicAnalysis.endpoints[k].callConv
  ],
  [
    "default.Deflate.push",
    "___railcar_anon_func_0___",
    "Method"
  ],
   */
  Object.keys(dynamicAnalysis.endpoints).forEach((k: string) => {
      const callConv = dynamicSchema[k].callconv
      if(callConv === "Method" || callConv === "Constructor") {
        const methodName = dynamicAnalysis.endpoints[k].name
        if (schemaJson[k] === undefined) {
          // check if methodName is unique (otherwise we don't know which)
          const filtered = allFunctions.filter((v: CustomExport) => v.name === methodName);
          if (filtered.length === 1) {
            const f:CustomExport = filtered[0]
            const func = typeModel.getTypeNode(f.id).objectType;
            const retType = getSchemaFromIds([...func.return.values()])
            let retValue = isEmptyObject(retType) ? {
                  "isAny": true,
                  "kind": {}
                } : mergeRet(retType);
            
            const classType:any = {}
            if (callConv === "Constructor") {
              classType[k] = 1
              retValue = {
                "isAny": false,
                "kind": {
                  "Class": 1
                },
                "classType": classType
              };
            } else {
              classType[`${k.substring(0, k.lastIndexOf("."))}`] = 1
            }
            schemaJson[k] = {
              callconv: dynamicSchema[k].callconv,
              args: [
                  {
                    "isAny": false,
                    "kind": {
                      "Class": 1
                    },
                    "classType": classType
                  },
                  ...getSchemaFromIds(
                      [...func.parameters.values()],
                  )
                ],
                ret: retValue,
            };
          }
        }
      }
  })

  const final = mergeSchemas(schemaJson, dynamicAnalysis.schema);
  return final;
}


function mergeSchemas(s1: any, s2: Schema) {
  Object.keys(s2).forEach(function(key) {
    const value = s2[key];
    if (!s1.hasOwnProperty(key)) {
      s1[key] = value
    } else {
      const s1Value = s1[key] 
      if (s1Value["callconv"] != value.callconv) {
        s1[key].callconv = value.callconv
        s1[key].ret = value.ret
      }
    }
  });
  return s1;
}