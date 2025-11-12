import assert from "node:assert";
import { isAbsolute, join, normalize } from "node:path";

import index from "./index.html";

import { collectProjectInfo } from "./data.js";

function toAbsolute(path: string) {
    return isAbsolute(path) ? path : normalize(join(process.cwd(), path));
}

export type ProjectsResponse = Record<
    string,
    {
        name: string;
        mode: string;
        corpus: number;
        crashes: number;
        coverage: [number, number][] | null;
    }
>;

async function getProjectsForUI(
    _: Bun.BunRequest,
    config: ServerConfig,
): Promise<Response> {
    // TODO: cache this somewhere
    const infos = await collectProjectInfo(config.rootDir);

    const data: ProjectsResponse = {};
    for (const info of infos) {
        const coverage = info.status?.coverage;
        data[info.name] = {
            name: info.name,
            mode: info.mode,
            corpus: info.status?.corpusCount ?? 0,
            crashes: info.status?.crashesCount ?? 0,
            coverage:
                coverage !== undefined && coverage.length > 0
                    ? coverage.map(
                          (tp) => [tp.timestamp, tp.data * 100], // percent
                      )
                    : null,
        };
    }
    return new Response(JSON.stringify(data), {
        headers: {
            "Content-Type": "application/json",
        },
    });
}

type ServerConfig = {
    rootDir: string;
};

function getArgs(): ServerConfig {
    const rootDir = process.argv[2];
    assert(typeof rootDir === "string");
    assert(rootDir);
    return {
        rootDir: toAbsolute(rootDir),
    };
}

async function main() {
    const config = getArgs();

    console.log(`Searching for fuzzers in ${config.rootDir}`);

    const server = Bun.serve({
        routes: {
            "/": index,
            "/api/projects": async (req) => getProjectsForUI(req, config),
        },
        fetch() {
            return new Response("Not Found", { status: 404 });
        },
    });

    console.log(`Server running at ${server.url}`);
}

main().catch(console.error);
