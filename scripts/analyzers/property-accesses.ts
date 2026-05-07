import { readFile } from "node:fs/promises";

import { transform, type PluginTarget } from "@babel/core";

function makeObjectPropertyAccessCountPlugin(): [
    () => number,
    () => PluginTarget,
] {
    let count = 0;
    return [
        () => count,
        () => {
            return {
                visitor: {
                    MemberExpression() {
                        count++;
                    },
                    OptionalMemberExpression() {
                        count++;
                    },
                },
            };
        },
    ];
}

export function countObjectPropertyAccesses(code: string): Promise<number> {
    const [getCount, plugin] = makeObjectPropertyAccessCountPlugin();

    return new Promise((res, rej) => {
        transform(code, { plugins: [plugin] }, (err, result) => {
            if (err || !result) return rej(Error("failed to parse"));
            res(getCount());
        });
    });
}

export async function countObjectPropertyAccessesInFile(
    path: string,
): Promise<number> {
    const code = await readFile(path, "utf-8");
    return countObjectPropertyAccesses(code);
}
