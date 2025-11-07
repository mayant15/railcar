import assert from "node:assert"
import {isAbsolute, join, normalize} from "node:path"
import Handlebars from "handlebars"

import {collectProjectInfo} from "./data.js"

function toAbsolute(path: string) {
    return isAbsolute(path) ? path : normalize(join(process.cwd(), path))
}

async function home(req: Bun.BunRequest<"/">, config: ServerConfig) {
    const info = await collectProjectInfo(config.rootDir);

    // TODO: precompile handlebars
    const text = await Bun.file("./templates/index.handlebars").text();
    const template = Handlebars.compile(text);
    return template({fuzzers: info})
}

type ServerConfig = {
    rootDir: string,
}

function getArgs(): ServerConfig {
    const rootDir = process.argv[2];
    assert(typeof rootDir === "string")
    assert(rootDir)
    return {
        rootDir: toAbsolute(rootDir),
    };
}

function mkResponse(html: string) {
    return new Response(html, {
        headers: {
            "Content-Type": "text/html",
        },
    });
}

async function main() {
    const config = getArgs();

    console.log(`Searching for fuzzers in ${config.rootDir}`)

    const server = Bun.serve({
        routes: {
            "/": async req => mkResponse(await home(req, config)),
        },
        fetch() {
            return new Response("Not Found", {status: 404})
        },
    })

    console.log(`Server running at ${server.url}`)
}

main().catch(console.error)
