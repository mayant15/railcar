export type AppState = {
    projects: ProjectInfo[]
}

enum StatusCode {
    Running = 0,
    Stopped,
}

export type ProjectInfo = {
    name: string,
    crashes: number,
    corpus: number,
    status: StatusCode,
    coverage: Record<string, CoverageInfo>,
}

type CoverageInfo = CoveragePoint[]
type CoveragePoint = {
    timestamp: number,
    value: number,
    min?: number,
    max?: number,
}

export function createAppState(): AppState {
    return {
        projects: []
    }
}
