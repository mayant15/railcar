/**
 * List all functions in the source file.
 * Split-off from branch-extract.ts.
 *
 * Generated with Amp.
 * https://ampcode.com/threads/T-019dfa11-4277-77f3-be17-4125ea8163e4
 * https://ampcode.com/threads/T-019e2cb3-9730-7581-92c2-ec126bcac3ef
 * https://ampcode.com/threads/T-019e2daf-7c8b-722d-80b6-a9e00dcbc115
 */

import type { NodePath, PluginTarget } from "@babel/core";
import type {
    Function as BabelFunction,
    ClassMethod,
    ClassPrivateMethod,
    Identifier,
    ObjectMethod,
    PrivateName,
    Program,
    SourceLocation,
} from "@babel/types";
import { createHash } from "node:crypto";

/**
 * Canonical key for an enclosing function. `loc == null` represents the
 * top-level script body (i.e. branches not inside any function).
 */
export type CanonicalFunctionKey = {
    file: string;
    loc: SourceLocation | null;
};

/**
 * Compute the canonical function ID. Mirrors `getCanonicalBranchId`: the
 * same `(file, location)` always produces the same ID. Top-level branches
 * (no enclosing function) get a stable file-scoped sentinel ID.
 *
 * The ID for a function matches the `functionId` recorded on every branch
 * arm inside that function, including its own `FnEntry` arm, so rows can
 * be grouped by function without re-walking the AST.
 */
export function getCanonicalFunctionId(key: CanonicalFunctionKey): string {
    const s = key.loc
        ? `${key.file}:Function:${key.loc.start.line}:${key.loc.start.column}:${key.loc.end.line}:${key.loc.end.column}`
        : `${key.file}:TopLevel`;
    return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

/**
 * Per-function attributes, keyed by the same canonical `id` recorded on
 * every branch arm inside the function. The top-level script body gets a
 * synthetic row with `type == "TopLevel"` so script-scope branches have a
 * matching parent in the functions table.
 */
export type FunctionAttr = {
    /** Canonical function ID. Joins to `BranchArm.functionId`. */
    id: string;
    file: string;
    library: string;
    /**
     * Best-effort source name. `null` for anonymous functions and the
     * top-level script. Pulled from `node.id` (FunctionDeclaration /
     * named FunctionExpression) or from `node.key` for object/class
     * methods. Computed property keys are stringified shallowly.
     */
    name: string | null;
    /**
     * Babel node type (e.g. `FunctionDeclaration`,
     * `ArrowFunctionExpression`, `ObjectMethod`, `ClassMethod`,
     * `ClassPrivateMethod`), or `"TopLevel"` for the script-scope row.
     */
    type: string;
    async: boolean;
    generator: boolean;
    /** Number of declared parameters (rest/defaults each count as one). */
    params: number;
    startLine: number;
    /** 0-indexed, matches Babel/V8 conventions. */
    startCol: number;
    endLine: number;
    endCol: number;
    /** Byte offsets into the source. */
    startOffset: number;
    endOffset: number;
};

function methodName(
    key: ObjectMethod["key"] | ClassMethod["key"] | PrivateName,
    computed: boolean,
): string | null {
    if (!key) return null;
    // For computed keys (e.g. `{ [k]() {} }`), the source token is just
    // an expression — not the actual property name — so we can't record
    // a stable name without evaluating it. Treat as anonymous.
    if (computed) return null;
    if (key.type === "Identifier") return (key as Identifier).name;
    if (key.type === "StringLiteral") return key.value;
    if (key.type === "NumericLiteral") return String(key.value);
    if (key.type === "PrivateName") return `#${key.id.name}`;
    return null;
}

function functionName(node: BabelFunction): string | null {
    switch (node.type) {
        case "FunctionDeclaration":
        case "FunctionExpression":
            return node.id?.name ?? null;
        case "ObjectMethod":
        case "ClassMethod": {
            const m = node as ObjectMethod | ClassMethod;
            return methodName(m.key, m.computed);
        }
        case "ClassPrivateMethod":
            // Private names are never computed.
            return methodName((node as ClassPrivateMethod).key, false);
        default:
            return null;
    }
}

export class FunctionExtractor {
    functions: FunctionAttr[] = [];
    file: string;
    library: string;

    constructor(file: string, library: string) {
        this.file = file;
        this.library = library;
    }

    plugin(): PluginTarget {
        // Capture `this` in a closure and use it in the visitor to share state.
        const self = this;

        return {
            visitor: {
                Program(path: NodePath<Program>) {
                    // One `TopLevel` row for the entire script.
                    // NOTE: This must be the parent of script-scope branches.
                    self.emitTop(path.node);
                },

                Function: {
                    enter(path: NodePath<BabelFunction>) {
                        self.emit(path.node);
                    },
                },
            },
        };
    }

    private emit(node: BabelFunction): void {
        if (node.start == null || node.end == null || !node.loc) return;
        this.functions.push({
            id: getCanonicalFunctionId({ file: this.file, loc: node.loc }),
            file: this.file,
            library: this.library,
            name: functionName(node),
            type: node.type,
            async: Boolean((node as { async?: boolean }).async),
            generator: Boolean((node as { generator?: boolean }).generator),
            params: node.params.length,
            startLine: node.loc.start.line,
            startCol: node.loc.start.column,
            endLine: node.loc.end.line,
            endCol: node.loc.end.column,
            startOffset: node.start,
            endOffset: node.end,
        });
    }

    private emitTop(node: Program): void {
        if (node.start == null || node.end == null || !node.loc) return;
        this.functions.push({
            id: getCanonicalFunctionId({ file: this.file, loc: null }),
            file: this.file,
            library: this.library,
            name: null,
            type: "TopLevel",
            async: false,
            generator: false,
            params: 0,
            startLine: node.loc.start.line,
            startCol: node.loc.start.column,
            endLine: node.loc.end.line,
            endCol: node.loc.end.column,
            startOffset: node.start,
            endOffset: node.end,
        });
    }
}
