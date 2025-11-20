/**
 * SPDX-FileCopyrightText: Mayant Mukul
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Entry point for the reporter. Just serve the main HTML and set up routes.
 */

import assert from "node:assert";
import { isAbsolute, join, normalize } from "node:path";

import index from "./client/index.html";
import { createStore, updateStore } from "./server/store.ts";
import { projects } from "./server/routes.ts";

const POLL_DURATION_SECS = 15;

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

    console.log("  processing fuzzer data...");
    const store = await createStore(config.rootDir);
    console.log("    done!");

    setInterval(() => {
        updateStore(store);
    }, POLL_DURATION_SECS);

    const server = Bun.serve({
        routes: {
            "/": index,
            "/api/projects": () => projects(store),
        },
        fetch() {
            return new Response("Not Found", { status: 404 });
        },
    });

    console.log(`Server running at ${server.url}`);
}

main().catch(console.error);
