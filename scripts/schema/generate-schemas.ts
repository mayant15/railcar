import assert from "node:assert";
import fs from "node:fs";
import { $ } from "bun";

import type { Schema } from "@railcar/inference";

import {
    type Project,
    getProjectNames,
    getProjectSpec,
    findEntryPoint,
} from "../common";

function pruneExtraKeys(schema: Schema, keep: Set<string>): Schema {
    return Object.fromEntries(
        Object.entries(schema).filter(([name, _]) => keep.has(name)),
    );
}

async function generateRandom(
    project: Project,
    entrypoint: string,
    keep: Set<string>,
): Promise<string[]> {
    const outFile = `examples/${project}/random.json`;
    const config = `examples/${project}/railcar.config.js`;

    await $`npx railcar-infer --dynamic --entrypoint ${entrypoint} --outFile ${outFile} --config ${config}`.quiet();

    const schema = await Bun.file(outFile).json();
    const filtered = pruneExtraKeys(schema, keep);
    Bun.write(outFile, JSON.stringify(filtered, null, 4));

    return Object.keys(filtered);
}

async function generateSynTest(
    project: Project,
    entrypoint: string,
    keep: Set<string>,
): Promise<string[]> {
    const outFile = `examples/${project}/syntest.json`;
    const config = `examples/${project}/railcar.config.js`;

    await $`npx railcar-infer --syntest --entrypoint ${entrypoint} --outFile ${outFile} --config ${config}`;

    // TODO: fix the "Sharp2" bug
    if (project === "sharp") {
        await $`sed -i 's/Sharp2/Sharp/g' ${outFile}`
    }

    const schema = await Bun.file(outFile).json();
    const filtered = pruneExtraKeys(schema, keep);
    Bun.write(outFile, JSON.stringify(filtered, null, 4));

    return Object.keys(filtered);
}

async function generateTypeScript(
    project: Project,
    entrypoint: string,
): Promise<string[]> {
    const outFile = `examples/${project}/typescript.json`;
    const config = `examples/${project}/railcar.config.js`;

    const spec = getProjectSpec(project);
    const decl = "decl" in spec ? spec.decl : undefined;
    assert(decl !== undefined);

    await $`npx railcar-infer --decl ${decl} --entrypoint ${entrypoint} -o ${outFile} --config ${config}`.quiet();

    const schema = await Bun.file(outFile).json();
    return Object.keys(schema);
}

async function findBundle(project: Project) {
    const path = `tmp/${project}.bundle.js`;
    assert(
        fs.existsSync(path),
        `SynTest inference requires a bundle. File ${path} does not exist.`,
    );
    return path;
}

async function main() {
    const projects = getProjectNames();

    let i = 1;
    for (const project of projects) {
        console.log(`[${i++}/${projects.length}]`, "Generating", project);

        const entrypoint = await findEntryPoint(project);

        console.log("  TypeScript");
        const keysTypeScript = await generateTypeScript(project, entrypoint);
        const keep = new Set(keysTypeScript);

        console.log("  Random");
        await generateRandom(project, entrypoint, keep);

        console.log("  SynTest");
        const bundle = await findBundle(project);
        await generateSynTest(project, bundle, keep);
    }
}

main();
