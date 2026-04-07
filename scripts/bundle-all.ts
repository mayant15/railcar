/**
 * Bundles all libraries for analysis.
 */

import assert from "node:assert";
import path from "node:path";
import fs from "node:fs/promises";
import {
    getProjectNames,
    getProjectSpec,
    type Project,
    type Spec,
} from "./common";

async function bundle(project: Project, spec: Spec, outdir: string) {
    assert(spec.bundle !== undefined, `"${project}" is missing a bundle`);

    const outfile = path.join(outdir, `${project}.bundle.js`);
    if (await fs.exists(outfile)) {
        console.warn(`[WARN] Skipping ${project}. Bundle ${outfile} exists`);
        return;
    }

    if (typeof spec.bundle === "string") {
        // Copy an existing bundle
        await fs.copyFile(spec.bundle, outfile);
    } else {
        // Create a new bundle
        await spec.bundle(outfile);
    }
}

type Args = {
    outdir: string;
};

function parseArgs(): Args {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        console.error("Usage: bun run bundle-all.ts <outdir>");
        process.exit(1);
    }

    return { outdir: argv[0] };
}

async function main() {
    const args = parseArgs();
    await fs.mkdir(args.outdir, { recursive: true });

    for (const project of getProjectNames()) {
        bundle(project, getProjectSpec(project), args.outdir);
    }
}

main();
