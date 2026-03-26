import assert from "node:assert";
import { readFile } from "node:fs/promises";

import { transformSync, type PluginTarget } from "@babel/core";

function makeObjectPropertyAccessCountPlugin(): [
    () => number,
    () => PluginTarget,
] {
    let count = 0;
    let functionDepth = 0;
    return [
        () => count,
        () => {
            return {
                visitor: {
                    Function: {
                        enter() {
                            functionDepth++;
                        },
                        exit() {
                            functionDepth--;
                        },
                    },
                    MemberExpression() {
                        if (functionDepth > 0) count++;
                    },
                    OptionalMemberExpression() {
                        if (functionDepth > 0) count++;
                    },
                },
            };
        },
    ];
}

export function countObjectPropertyAccesses(code: string): number {
    const [getCount, plugin] = makeObjectPropertyAccessCountPlugin();

    const result = transformSync(code, {
        plugins: [plugin],
    });
    assert(result !== null);

    return getCount();
}

export async function countObjectPropertyAccessesInFile(
    path: string,
): Promise<number> {
    const code = await readFile(path, "utf-8");
    return countObjectPropertyAccesses(code);
}
