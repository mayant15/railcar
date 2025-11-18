import { AbstractSyntaxTreeFactory, TypeExtractor, InferenceTypeModelFactory,ExportFactory, TypeEnum, Export, Relation, Element } from "@syntest/analysis-javascript";
import { unwrap, Result } from "@syntest/diagnostics";
import * as t from "@babel/types";
import { setupLogger } from "@syntest/logging";
import { exit } from "process";
import * as fs from "fs";
import { transform } from "./program-transform";
import { TypeNode } from "@syntest/analysis-javascript/dist/lib/type/resolving/TypeNode";
import { loadSchema } from "./reflection";
import { absolute } from "./common";
import type { Schema } from "./schema";

const SYNTAX_FROGIVING = true;
const typeExtractor = new TypeExtractor(SYNTAX_FROGIVING); // syntaxForgiving??

export interface CustomExport extends Export {
  id: string;
  filePath: string;
  name: string;
  renamedTo: string;
  default: boolean;
  module: boolean;
  probabilities?: {
      [k: string]: number;
  }|null|undefined,
  root?: string|null|undefined;
}

const allTypeValues: TypeEnum[] = Object.values(TypeEnum);
setupLogger("", [], "debug");

export async function syntestSchema(fileName: string) {
  const filePath = "";
  const source = transform(fs.readFileSync(fileName, "utf8"), fileName + "_transformed.js");
  // const lines = source.split(/\r?\n/);
  const exportFactory = new ExportFactory(SYNTAX_FROGIVING);
  // Get ast
  const generator = new AbstractSyntaxTreeFactory();
  const result: Result<t.Node> = generator.convert(filePath, source);
  if (!result.success) {
    return {};
  }
  const astUnwrapped = unwrap(result);
  // Get exported functions
  // libraries/analysis-javascript/lib/target/export/ExportFactory.ts
  const exportResult: Result<Export[]> = exportFactory.extract(filePath, astUnwrapped);
  if (!exportResult.success) {
    return {};
  }
  const exportedFunctions: CustomExport[] = exportResult.result;
  // get elements & relations
  const elementsResult: Result<Map<string, Element>>  = typeExtractor.extractElements(filePath, astUnwrapped);
  if (!elementsResult.success) {
    return {};
  }
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

  // @ts-ignore
  globalThis.relationsResult = relationsResult
  // @ts-ignore
  globalThis.elementsResult = elementsResult
  // @ts-ignore
  globalThis.typeModel = typeModel

  typeModel.typeNodes.forEach((value: TypeNode, key: string) => {
    try {
      value.getTypeProbabilities();
    } catch (e) {
      console.log("It's ", value.id, " that fails")
      exit(0);
    }
  });

  const reg = /^:(\d+):(\d+):::(\d+):(\d+):::(\d+):(\d+)(.*)$/;

  let schemaJson: any = {};
  let idMap = new Map()
  let objIdMap = new Map()

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
      return {}
    } else {
      objIdMap.set(id, true)
    }
    let objSchema: any = {}
    const node = typeModel.getTypeNode(id)
    const objProperties = node.objectType.properties
    Array.from(objProperties.entries()).forEach(([key, value]) => {
      objSchema[key] = getSchemaFromId(value, key);
    });
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

  function removeEmptyObjFields(obj: any) {
    return Object.fromEntries(
      Object.entries(obj).filter(([_, value]) => value !== 0)
    )
  }

  /*
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
      const total: any|number = Object.values(kind).reduce((a: any, b: any) => a + b, 0);
      if (total !== 0) {
        for (const k in kind) {
          kind[k] = kind[k] / total;
        }
      }
    }

    return merged;
  }
    */

  function getSchemaFromId(id: string, name: string) {
    if (idMap.get(id)) {
      return {}
    } else {
      idMap.set(id, true)
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
          const [,startRow,startCol,endRow,endCol,startInd,endInd,,] = type.match(reg)
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
      typesJson = removeEmptyObjFields(typesJson)
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
    const mergedObjShapes = objectType; // mergeObjectShapes(objectType)
    let result: any = {}
    result.isAny = !hasType
    result.kind = hasType ? typesJson : {}
    if (!isEmptyObject(mergedObjShapes)) {
      result.objectShape = mergedObjShapes
    }
    if (couldBeArray) {
      result.arrayValueType = {
        "isAny": true,
        "kind": {}
      }
    }
    return result
  }

  function mergeRet(ret: any[]) {
    if (!Array.isArray(ret)) {
      return ret;
    } 
    if (ret.length <= 1) {
      return ret[0];
    }

    const mergedKind:any = {};
    let totProbabilities: number = 0;

    for (const obj of ret) {
      for (const [key, value] of Object.entries(obj.kind)) {
        mergedKind[key] = (mergedKind[key] || 0) + value;
        totProbabilities += value as number;
      }
    }

    const normalizedKind: any = {};
    for (const [key, value] of Object.entries(mergedKind)) {
      normalizedKind[key] = (value as number) / totProbabilities;
    }

    return {
      isAny: false,
      kind: normalizedKind,
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

  for (const index in exportedFunctions) {
    let fid: string = exportedFunctions[index].id;
    if (fid === undefined) {
      continue;
    } else {
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
              exportedFunctions[index].probabilities = probs;
              exportedFunctions[index].root = fid
            } else {
              // save
              exportedFunctions[index].probabilities = targetProb;
              exportedFunctions[index].root = targetID;
            }
            break;
          } else {
            // console.log("Found L=R, assigning")
          }
          fid = node.involved[1];
          targetID = fid;
          targetProb = probs;
        } else {
          node = elementsResult.result.get(fid);
          // console.log(`fid - ${fid} - is element, getting element's bindingId now`)
          if (node !== undefined) {
            fid = node.bindingId;
          } else {
          }
        }
      } while (node !== null && node !== undefined);

      let foundFunctionDeclaration = false;
      for (const key in exportedFunctions[index].probabilities) {
        if (key.includes("function")) {
          const match = key.match(reg) === null ? exportedFunctions[index].root?.match(reg) : key.match(reg)
          // @ts-ignore
          const [,startLine,startColumn,endLine,endColum,startIndex,endIndex,] = match;
          const id = `:${startLine}:${startColumn}:::${endLine}:${endColum}:::${startIndex}:${endIndex}`;
          const func = typeModel.getTypeNode(id).objectType;
          foundFunctionDeclaration = true;
          const retType = getSchemaFromIds([...func.return.values()])
          schemaJson[exportedFunctions[index]["name"]] = {
            id: id,
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
          break;
        }
      }
      if (!foundFunctionDeclaration) {
        // schemaJson[exportedFunctions[index]["name"]] = {}
        // console.log("No function declaration found");
      }
      // const typeNode = typeModel.getTypeNode(targetID);
      // const probs = Object.fromEntries(typeNode.getTypeProbabilities())
      // console.log(`target is: ${targetID}, props = ${JSON.stringify(probs, null, 2)}`)
    }
  }

    // fs.writeFileSync(
    //   absolute(fileName + "-schema.json"),
    //   JSON.stringify(schemaJson, null, 2)
    // );
    const dynamicSchema = (await loadSchema(fileName)).schema
    return mergeSchemas(schemaJson, dynamicSchema);
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