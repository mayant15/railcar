import path from "node:path"
import fs from "node:fs/promises"

enum FuzzerStatusCode {
    Running,
    Crashed,
    Exited
}

type TimePoint<T> = {
    timestamp: number,
    data: T
}

type FuzzerStatus = {
    code: FuzzerStatusCode,
    corpusCount: number,
    crashesCount: number,
    coverage: TimePoint<number>[],
}

type ProjectInfo = {
    // constants that are not going to change over time
    name: string,
    outdir: string,
    cores: number[],
    corpusPath: string,
    crashesPath: string,
    metricsPath: string
    mode: string,
    port: number,
    schemaPath: string | null,
    seed: number,
    perTestTimeout: number,
    pid: number

    // status that would change over time
    status?: FuzzerStatus
}

type FuzzerConfig = {
    config: {
        config_file: string,
        cores: {
            cmdline: string,
            ids: number[]
        },
        corpus: string,
        crashes: string,
        entrypoint: string,
        metrics: string,
        mode: string,
        port: number,
        replay: boolean,
        replay_input: string | null,
        schema_file: string | null,
        seed: number,
        simple_mutations: boolean,
        timeout: {
            nanos: number,
            secs: number
        },
        use_validity: boolean
    },
    pid: number
}

async function fetchFuzzerCorpusCount(info: ProjectInfo): Promise<number> {
    if (!(await fs.exists(info.corpusPath))) {
        return 0;
    }
    const files = await fs.readdir(info.corpusPath);

    // every file `input` has a hidden `.input` file
    return files.length / 2
}

async function fetchFuzzerCrashesCount(info: ProjectInfo): Promise<number> {
    if (!(await fs.exists(info.crashesPath))) {
        return 0;
    }
    const files = await fs.readdir(info.crashesPath);

    // every file `input` has a hidden `.input` and `.input_1.metadata` file
    return files.length / 3
}

async function fetchFuzzerStatus(info: ProjectInfo): Promise<ProjectInfo> {
    // TODO: fetch fuzzer status
    const code = FuzzerStatusCode.Running

    const [corpusCount, crashesCount] = await Promise.all([
        fetchFuzzerCorpusCount(info),
        fetchFuzzerCrashesCount(info)
    ])

    return {
        ...info,
        status: {
            code,
            corpusCount,
            crashesCount,
            coverage: []
        }
    }
}

export async function collectProjectInfoForDir(dir: string): Promise<ProjectInfo> {
    const name = await Bun.file(`${dir}/project`).text()
    const fuzzerConfig: FuzzerConfig = await Bun.file(`${dir}/fuzzing-config.json`).json()
    return fetchFuzzerStatus({
        name,
        outdir: dir,
        cores: fuzzerConfig.config.cores.ids,
        metricsPath: fuzzerConfig.config.metrics,
        corpusPath: fuzzerConfig.config.corpus,
        crashesPath: fuzzerConfig.config.crashes,
        mode: fuzzerConfig.config.mode,
        port: fuzzerConfig.config.port,
        schemaPath: fuzzerConfig.config.schema_file,
        seed: fuzzerConfig.config.seed,
        perTestTimeout: fuzzerConfig.config.timeout.secs + fuzzerConfig.config.timeout.nanos / 1e9,
        pid: fuzzerConfig.pid,
    })
}

export async function collectProjectInfo(rootDir: string): Promise<ProjectInfo[]> {
    const glob = new Bun.Glob(`${rootDir}/**/project`)
    const result: ProjectInfo[] = []
    for await (const file of glob.scan()) {
        result.push(await collectProjectInfoForDir(path.dirname(file)))
    }
    return result
}
