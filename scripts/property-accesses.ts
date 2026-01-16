import assert from "node:assert";

import { transformSync, type PluginTarget } from "@babel/core";

function makeObjectPropertyAccessCountPlugin(): [
    () => number,
    () => PluginTarget,
] {
    const count = 0;
    return [
        () => count,
        () => {
            return {};
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
