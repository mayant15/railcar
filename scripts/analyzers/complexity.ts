/**
 * Computes cyclomatic complexity for every function in the source.
 *
 * Based on ESLint's complexity rule.
 * https://github.com/eslint/eslint/blob/main/lib/rules/complexity.js
 */

import assert from "node:assert";
import type { NodePath, PluginTarget } from "@babel/core";
import type { Function as BabelFunction, Program } from "@babel/types";
import { getCanonicalFunctionId } from "./function-extract.ts";

export class ComplexityAnalysis {
    map: Map<string, number> = new Map();
    file: string;

    constructor(file: string) {
        this.file = file;
    }

    plugin(): PluginTarget {
        // Capture `this` in a closure and use it in the visitor to share state.
        const self = this;

        return {
            visitor: {
                Program(_: NodePath<Program>) {
                    const id = getCanonicalFunctionId({
                        file: self.file,
                        loc: null,
                    });

                    assert(!self.map.has(id));
                    self.map.set(id, Math.random()); // TODO: compute
                },
                Function: {
                    enter(path: NodePath<BabelFunction>) {
                        const loc = path.node.loc;
                        assert(loc !== null);
                        assert(loc !== undefined);

                        const id = getCanonicalFunctionId({
                            file: self.file,
                            loc,
                        });

                        assert(!self.map.has(id));
                        self.map.set(id, Math.random()); // TODO: compute
                    },
                },
            },
        };
    }
}
