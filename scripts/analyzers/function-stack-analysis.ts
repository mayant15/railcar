/**
 * Base class for per-function analysis. Keeps a stack of active functions,
 * and tallies collected metrics only for the top of the stack.
 */

import assert from "node:assert";
import type { NodePath, PluginTarget } from "@babel/core";
import type { Function as BabelFunction } from "@babel/types";
import { getCanonicalFunctionId } from "./function-extract.ts";

export class FunctionStackAnalysis<T> {
    file: string;

    stack: string[] = [];
    map: Map<string, T> = new Map();

    constructor(file: string) {
        this.file = file;
    }

    createStackPlugin(target: { visitor: object }): PluginTarget {
        const self = this;
        return {
            visitor: {
                ...target.visitor,
                Program: {
                    enter(path: NodePath<BabelFunction>) {
                        const id = getCanonicalFunctionId({
                            file: self.file,
                            loc: null,
                        });
                        assert(!self.map.has(id));
                        assert(self.stack.length === 0);

                        self.stack.push(id);

                        if ("Program" in target.visitor) {
                            assert(
                                typeof target.visitor.Program === "function",
                            );
                            target.visitor.Program(path);
                        }
                    },
                    exit() {
                        const top = self.stack.pop();
                        assert(top);
                    },
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
                        self.stack.push(id);

                        if ("Function" in target.visitor) {
                            assert(
                                typeof target.visitor.Function === "function",
                            );
                            target.visitor.Function(path);
                        }
                    },
                    exit() {
                        const top = self.stack.pop();
                        assert(top);
                    },
                },
            },
        };
    }
}
