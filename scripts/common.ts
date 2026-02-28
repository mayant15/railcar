import type { SignatureGuess } from "@railcar/inference";

const PROJECTS = {
    lodash: {
        decl: "node_modules/@types/lodash/index.d.ts",
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
        decl: "node_modules/@xmldom/xmldom/index.d.ts",
        known: [
            "assign",
            "NamedNodeMap",
            "NodeList",
            "DOMImplementation",
            "XMLSerializer",
        ],
    },
    typescript: {
        decl: "node_modules/typescript/lib/typescript.d.ts",
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
    },
    "fast-xml-parser": {
        bundle: "examples/fast-xml-parser/fxp.full.js",
        decl: "node_modules/fast-xml-parser/src/fxp.d.ts",
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
        bundle: "examples/jimp/jimp.browser.js",
        decl: "node_modules/jimp/dist/commonjs/index.d.ts",
    },
    "jpeg-js": {
        bundle: "examples/jpeg-js/jpeg-js.bundle.js",
        decl: "node_modules/jpeg-js/index.d.ts",
    },
    "js-yaml": {
        bundle: "node_modules/js-yaml/dist/js-yaml.js",
        decl: "node_modules/@types/js-yaml/index.d.ts",
    },
    sharp: {
        decl: "node_modules/sharp/lib/index.d.ts",
    },
    turf: {
        decl: "node_modules/@turf/turf/dist/esm/index.d.ts",
    },
    xml2js: {
        decl: "node_modules/@types/xml2js/index.d.ts",
    },
    angular: {
        decl: "node_modules/@angular/compiler/index.d.ts",
    },

    // "ua-parser-js": {
    //     decl: "node_modules/ua-parser-js/src/main/ua-parser.d.ts",
    // },
} as const;

export type Project = keyof typeof PROJECTS;

type Spec = {
    bundle?: string;
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
