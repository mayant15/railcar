/**
 * SPDX-FileCopyrightText: Mayant Mukul
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Entry point for the reporter. Just serve the main HTML.
 */

import assert from "node:assert";
import { isAbsolute, join, normalize } from "node:path";

import index from "./client/index.html";

type ServerConfig = {
    rootDir: string;
};

function toAbsolute(path: string) {
    return isAbsolute(path) ? path : normalize(join(process.cwd(), path));
}

function parseServerConfig(): ServerConfig {
    const rootDir = process.argv[2];
    assert(typeof rootDir === "string");
    assert(rootDir);
    return {
        rootDir: toAbsolute(rootDir),
    };
}

async function main() {
    const config = parseServerConfig();
    console.log(`Searching for fuzzers in ${config.rootDir}...`);

    const server = Bun.serve({
        routes: {
            "/": index,
        },
        fetch() {
            return new Response("Not Found", { status: 404 });
        },
    });

    console.log(`Server running at ${server.url}`);
}

main().catch(console.error);
