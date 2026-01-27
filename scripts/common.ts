const PROJECTS = {
    "fast-xml-parser": {
        bundle: "examples/fast-xml-parser/fxp.full.js",
        decl: "node_modules/fast-xml-parser/src/fxp.d.ts",
    },
    tslib: {
        bundle: "node_modules/tslib/tslib.js",
        decl: "node_modules/tslib/tslib.d.ts",
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
    lodash: {},
    lit: {},
    protobufjs: {},
    turf: {},
    typescript: {},
    "ua-parser-js": {},
    xml2js: {},
    xmldom: {},
    angular: {},
    canvg: {},
    sharp: {},
} as const;

export type Project = keyof typeof PROJECTS;

type Spec = {
    bundle?: string;
    decl?: string;
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
