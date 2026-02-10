import assert from "node:assert";

import { $ } from "bun";

import { type Project, getProjectNames, getProjectSpec } from "./common";

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

    const text = await $`node ./examples/locate-index.js ${name}`
        .quiet()
        .text();
    return text.trim();
}

async function generateRandom(
    project: Project,
    entrypoint: string,
): Promise<string[]> {
    const outFile = `examples/${project}/random.json`;
    const config = `examples/${project}/railcar.config.js`;

    await $`npx railcar-infer --dynamic --entrypoint ${entrypoint} --outFile ${outFile} --config ${config}`.quiet();

    assert(await isIdempotent(project, entrypoint, outFile));

    const schema = await Bun.file(outFile).json();
    return Object.keys(schema);
}

// async function generateSynTest(project: Project) {
//     const entrypoint = SPECS[project]?.bundle ?? await findEntrypoint(project);
//
//     const outFile = `examples/${project}/syntest.json`;
//     const config = `examples/${project}/railcar.config.js`;
//
//     await $`npx railcar-infer --syntest ${entrypoint} -o ${outFile} --config ${config}`.quiet();
// }

async function generateTypeScript(
    project: Project,
    entrypoint: string,
): Promise<string[] | null> {
    const outFile = `examples/${project}/typescript.json`;
    const config = `examples/${project}/railcar.config.js`;

    const spec = getProjectSpec(project);
    const decl = "decl" in spec ? spec.decl : undefined;
    if (decl === undefined) {
        console.warn("WARN: no typescript declaration file set");
        return null;
    }

    try {
        await $`npx railcar-infer --decl ${decl} --entrypoint ${entrypoint} -o ${outFile} --config ${config}`.quiet();
    } catch (e) {
        console.error("ERROR: Failed to infer typescript spec for", project);
        console.error(e);
        return null;
    }

    assert(await isIdempotent(project, entrypoint, outFile));

    const schema = await Bun.file(outFile).json();
    return Object.keys(schema);
}

async function isIdempotent(
    project: string,
    entrypoint: string,
    schema: string,
): Promise<boolean> {
    const config = `examples/${project}/railcar.config.js`;

    Bun.spawnSync({
        cmd: [
            "cargo",
            "run",
            "--bin",
            "railcar",
            "--release",
            "--",
            "--config",
            config,
            "--mode",
            "sequence",
            "--schema",
            schema,
            "--iterations",
            "0",
            "--debug-dump-schema",
            "schema.json",
            entrypoint,
        ],
        stdout: "ignore",
        stderr: "ignore",
    });

    const diff = await $`diff ${schema} schema.json`.quiet();
    return diff.exitCode === 0;
}

async function main() {
    const projects = getProjectNames();

    let i = 1;
    for (const project of projects) {
        console.log(`[${i++}/${projects.length}]`, "Generating", project);

        const entrypoint = await findEntrypoint(project);

        console.log("  Random");
        const keysRandom = await generateRandom(project, entrypoint);

        console.log("  TypeScript");
        const keysTypeScript = await generateTypeScript(project, entrypoint);

        // these two should have the same set of APIs
        assert(keysTypeScript !== null);
        assert(keysRandom.length === keysTypeScript.length);

        const sortedA = keysTypeScript.sort();
        const sortedB = keysRandom.sort();

        for (let i = 0; i < sortedA.length; ++i) {
            assert(sortedA[i] === sortedB[i]);
        }

        // console.log("  SynTest");
        // await generateSynTest(project)

        // TODO: Assert they all have the same keys
        /**
  jq 'keys' $RAND > $RAND.keys.json
  jq 'keys' $SYNTEST > $SYNTEST.keys.json
  jq 'keys' $TYPESCRIPT > $TYPESCRIPT.keys.json

  set -e

  diff $RAND.keys.json $SYNTEST.keys.json
  diff $RAND.keys.json $TYPESCRIPT.keys.json
*/
    }
}

main();
