import { $ } from "bun";
import type { SignatureGuess } from "@railcar/inference";

const PROJECTS = {
    lodash: {
        decl: "node_modules/@types/lodash/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/lodash/index.js";
            await $`bunx esbuild ${index} --bundle --format=esm --platform=node --outfile=${outfile}`;
        },
        known: [
            "clone",
            "cloneDeep",
            "toPlainObject",
            "assign",
            "assignIn",
            "defaults",
            "extend",
            "merge",
            "defaultTo",
            "identity",
            "stubObject",
        ],
    },
    xmldom: {
        decl: "examples/xmldom/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/@xmldom/xmldom/lib/index.js";
            await $`bunx esbuild ${index} --bundle --format=esm --platform=node --outfile=${outfile}`;
        },
        known: [
            "assign",
            "NamedNodeMap",
            "NodeList",
            "DOMImplementation",
            "XMLSerializer",
            "Node",
            "Attr",
            "CharacterData",
            "Comment",
            "Element",
            "Text",
            "CDATASection",
            "DocumentFragment",
            "Entity",
            "EntityReference",
            "Notation",
            "ProcessingInstruction",
            "Document",
            "DocumentType",
        ],
    },
    typescript: {
        decl: "node_modules/typescript/lib/typescript.d.ts",
        bundle: "node_modules/typescript/lib/typescript.js",
        known: ["OperationCanceledException"],
    },
    tslib: {
        bundle: "node_modules/tslib/tslib.js",
        decl: "node_modules/tslib/tslib.d.ts",
        known: [
            "__values",
            "__await",
            "__asyncDelegator",
            "__asyncValues",
            "__importStar",
            "__importDefault",
        ],
    },
    protobufjs: {
        decl: "node_modules/protobufjs/index.d.ts",
        bundle: "node_modules/protobufjs/dist/protobuf.js",
        known: ["ReflectionObject", "Writer", "BufferWriter"],
    },
    lit: {
        decl: "node_modules/lit/index.d.ts",
        known: [
            "LitElement",
            "LitElement.render",
            "ReactiveElement",
            "CSSResult",
        ],
        bundle: async (outfile: string) => {
            const index = "node_modules/lit/index.js";
            await $`bunx esbuild ${index} --bundle --format=esm --platform=node --outfile=${outfile}`;
        },
    },
    "fast-xml-parser": {
        decl: "node_modules/fast-xml-parser/src/fxp.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/fast-xml-parser/src/fxp.js";
            await $`bunx esbuild ${index} --bundle --platform=node --outfile=${outfile}`;
        },
    },
    pako: {
        bundle: "node_modules/pako/dist/pako.js",
        decl: "node_modules/@types/pako/index.d.ts",
    },
    redux: {
        bundle: "node_modules/redux/dist/redux.mjs",
        decl: "node_modules/redux/dist/redux.d.ts",
    },
    jimp: {
        decl: "node_modules/jimp/dist/commonjs/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/jimp/dist/commonjs/index.js";
            await $`bunx esbuild ${index} --bundle --platform=node --outfile=${outfile}`;
        },
    },
    "jpeg-js": {
        decl: "node_modules/jpeg-js/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/jpeg-js/index.js";
            await $`bunx esbuild ${index} --bundle --outfile=${outfile}`;
        },
    },
    "js-yaml": {
        bundle: "node_modules/js-yaml/dist/js-yaml.js",
        decl: "node_modules/@types/js-yaml/index.d.ts",
    },
    sharp: {
        decl: "node_modules/sharp/lib/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/sharp/lib/index.js";
            await $`bunx esbuild ${index} --bundle --platform=node --format=cjs --outfile=${outfile}`;
        },
    },
    turf: {
        decl: "node_modules/@turf/turf/dist/esm/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/@turf/turf/dist/esm/index.js";
            await $`bunx esbuild ${index} --bundle --format=esm --platform=node --outfile=${outfile}`;
        },
    },
    xml2js: {
        decl: "node_modules/@types/xml2js/index.d.ts",
        bundle: async (outfile: string) => {
            const index = "node_modules/xml2js/lib/xml2js.js";
            await $`bunx esbuild ${index} --bundle --format=cjs --platform=node --outfile=${outfile}`;
        },
    },
    angular: {
        decl: "node_modules/@angular/compiler/index.d.ts",
        bundle: "node_modules/@angular/compiler/fesm2022/compiler.mjs",
    },
} as const;

export type Project = keyof typeof PROJECTS;

export type SchemaKind = "random" | "typescript" | "syntest";

export type Spec = {
    bundle?: string | ((outfile: string) => Promise<void>);
    decl?: string;
    known?: readonly string[];
};

export function getProjectNames(): Project[] {
    return Object.keys(PROJECTS) as Project[];
}

export function getProjectSpecs(): Record<Project, Spec> {
    return PROJECTS;
}

export function getProjectSpec(project: Project): Spec {
    return PROJECTS[project];
}

export function isNoInfoSignature(sig: SignatureGuess): boolean {
    if (sig.builtin) return false;
    switch (sig.callconv) {
        case "Free": {
            // ret and all args must be any
            return sig.ret.isAny && sig.args.every((arg) => arg.isAny);
        }
        case "Constructor": {
            // all args must be any
            return sig.args.every((arg) => arg.isAny);
        }
        case "Method": {
            // ret and all args[1..] must be any
            return sig.ret.isAny && sig.args.slice(1).every((arg) => arg.isAny);
        }
    }
}

export async function findEntryPoint(project: Project): Promise<string> {
    let name: string = project;
    switch (name) {
        case "turf": {
            name = "@turf/turf";
            break;
        }
        case "angular": {
            name = "@angular/compiler";
            break;
        }
        case "xmldom": {
            name = "@xmldom/xmldom";
            break;
        }
    }

    const text = await $`node ./examples/locate-index.js ${name}`
        .quiet()
        .text();
    return text.trim();
}
