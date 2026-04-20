/**
 * Generated with Amp
 * https://ampcode.com/threads/T-019dac8a-ebcc-72dc-9f40-cdb8016350ea
 */

import assert from "node:assert";

export type LineData = {
    line: number;
    count: number;
};

export type BranchData = {
    line: number;
    block: number;
    expr: number;
    count: number;
};

export type FnRef = {
    line: number;
    name: string;
};

export type FnData = {
    name: string;
    count: number;
};

export type LcovFile = {
    path: string;
    lines: LineData[];
    branches: BranchData[];
    functions: FnRef[];
    fnData: FnData[];
};

export function parseLcov(content: string): LcovFile[] {
    const files: LcovFile[] = [];
    let current: LcovFile | null = null;

    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line || line === "end_of_record") {
            if (line === "end_of_record" && current) {
                assert(current !== null);
                files.push(current);
                current = null;
            }
            continue;
        }

        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const kind = line.slice(0, idx);
        const body = line.slice(idx + 1);

        switch (kind) {
            case "TN":
                break;
            case "SF":
                current = {
                    path: body,
                    lines: [],
                    branches: [],
                    functions: [],
                    fnData: [],
                };
                break;
            case "DA": {
                const [ln, cnt] = body.split(",");
                assert(current !== null);
                current.lines.push({ line: Number(ln), count: Number(cnt) });
                break;
            }
            case "BRDA": {
                const [ln, block, expr, cnt] = body.split(",");
                assert(current !== null);
                current.branches.push({
                    line: Number(ln),
                    block: Number(block),
                    expr: Number(expr),
                    count: Number(cnt),
                });
                break;
            }
            case "FN": {
                const [ln, name] = body.split(",");
                assert(current !== null);
                current.functions.push({ line: Number(ln), name });
                break;
            }
            case "FNDA": {
                const [cnt, name] = body.split(",");
                assert(current !== null);
                current.fnData.push({ name, count: Number(cnt) });
                break;
            }
            // LF, LH, BRF, BRH, FNF, FNH — derived, skip
        }
    }

    return files;
}

export function formatLcov(files: LcovFile[]): string {
    const parts: string[] = [];

    for (const file of files) {
        parts.push("TN:");
        parts.push(`SF:${file.path}`);

        for (const fn of file.functions) {
            parts.push(`FN:${fn.line},${fn.name}`);
        }
        parts.push(`FNF:${file.functions.length}`);
        const fnHit = file.fnData.filter((d) => d.count > 0).length;
        parts.push(`FNH:${fnHit}`);
        for (const fd of file.fnData) {
            parts.push(`FNDA:${fd.count},${fd.name}`);
        }

        for (const l of file.lines) {
            parts.push(`DA:${l.line},${l.count}`);
        }
        parts.push(`LF:${file.lines.length}`);
        const linesHit = file.lines.filter((l) => l.count > 0).length;
        parts.push(`LH:${linesHit}`);

        for (const br of file.branches) {
            parts.push(`BRDA:${br.line},${br.block},${br.expr},${br.count}`);
        }
        parts.push(`BRF:${file.branches.length}`);
        const brHit = file.branches.filter((br) => br.count > 0).length;
        parts.push(`BRH:${brHit}`);

        parts.push("end_of_record");
    }

    return `${parts.join("\n")}\n`;
}
