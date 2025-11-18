import index from "./client/index.html";

import { collectProjectInfo, FuzzerStatusCode } from "./data.js";

export type ProjectsResponse = Record<
    string,
    {
        status: string;
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
            status:
                info.status?.code === undefined
                    ? "unknown"
                    : FuzzerStatusCode[info.status?.code],
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
