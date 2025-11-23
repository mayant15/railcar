export type ProjectsResponse = GroupedFuzzerInfo[];

export type GroupedFuzzerInfo = {
    name: string;
    data: GroupedFuzzerInfoData[];
};

export type GroupedFuzzerInfoData = {
    name: string;
    crashes: number;
    corpus: number;
    status: StatusCode;
    coverage: [number, number][];
};

export enum StatusCode {
    Running = 0,
    Stopped,
}
