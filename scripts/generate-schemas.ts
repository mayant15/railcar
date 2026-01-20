import { $ } from "bun";

import SPECS from "./projects.json";

const PROJECTS = [
    "fast-xml-parser",
    "jimp",
    "jpeg-js",
    "redux",
    "sharp",
    "tslib",
    "js-yaml",
    "pako",
    "lodash",
    "lit",
    "protobufjs",
    "turf",
    "typescript",
    "ua-parser-js",
    "xml2js",
    "xmldom",
    "angular",
    "canvg",
] as const;
// const PROJECTS = Object.keys(SPECS) as Project[]

type Project = keyof typeof SPECS;

async function findEntrypoint(project: Project): Promise<string> {
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

    return $`node ./examples/locate-index.js ${name}`.quiet().text();
}

async function generateRandom(project: Project, entrypoint: string) {
    const outFile = `examples/${project}/random.json`;
    const config = `examples/${project}/railcar.config.js`;

    await $`npx railcar-infer --dynamic --entrypoint ${entrypoint} --outFile ${outFile} --config ${config}`.quiet();
}

// async function generateSynTest(project: Project) {
//     const entrypoint = SPECS[project]?.bundle ?? await findEntrypoint(project);
//
//     const outFile = `examples/${project}/syntest.json`;
//     const config = `examples/${project}/railcar.config.js`;
//
//     await $`npx railcar-infer --syntest ${entrypoint} -o ${outFile} --config ${config}`.quiet();
// }

async function generateTypeScript(project: Project, entrypoint: string) {
    const outFile = `examples/${project}/typescript.json`;
    const config = `examples/${project}/railcar.config.js`;

    const decl = "decl" in SPECS[project] ? SPECS[project].decl : undefined;
    if (decl === undefined) {
        console.warn("WARN: no typescript declaration file set");
        return;
    }

    await $`npx railcar-infer --decl ${decl} --entrypoint ${entrypoint} -o ${outFile} --config ${config}`.quiet();
}

async function main() {
    for (const project of PROJECTS) {
        console.log("Generating", project);

        const entrypoint = await findEntrypoint(project);

        console.log("  Random");
        await generateRandom(project, entrypoint);

        console.log("  TypeScript");
        await generateTypeScript(project, entrypoint);
        // await generateSynTest(project)
    }
}

main();
