import assert from "node:assert"
import {isAbsolute, join, normalize} from "node:path"
import Handlebars from "handlebars"

import {collectProjectInfo, type ProjectInfo} from "./data.js"

function toAbsolute(path: string) {
    return isAbsolute(path) ? path : normalize(join(process.cwd(), path))
}

type HomeViewData = {
    name: string,
    mode: string,
    corpus: number,
    crashes: number,
    coverage?: [string, string][]
}

function makeViewData(infos: ProjectInfo[]): HomeViewData[] {
    return infos.map(info => {
        const coverage = info.status?.coverage?.map(point => {
            return [
                `${point.timestamp.toFixed()}s`,
                `${(point.data * 100).toFixed(1)}%`
            ] as [string, string]
        })
        return {
            name: info.name,
            mode: info.mode,
            corpus: info.status?.corpusCount ?? 0,
            crashes: info.status?.crashesCount ?? 0,
            coverage,
        }
    })
}

async function home(req: Bun.BunRequest<"/">, config: ServerConfig) {
    const info = await collectProjectInfo(config.rootDir);
    const viewData = makeViewData(info);

    // TODO: precompile handlebars
    const text = await Bun.file("./templates/index.hbs").text();
    const template = Handlebars.compile(text);
    return template(viewData)
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
