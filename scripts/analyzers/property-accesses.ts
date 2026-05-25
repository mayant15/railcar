/**
 * Count the number of object property accesses in each function.
 */

import assert from "node:assert";

import type { PluginTarget } from "@babel/core";
import { FunctionStackAnalysis } from "./function-stack-analysis.ts";

export class ObjectPropertyAccessAnalysis extends FunctionStackAnalysis<number> {
    overall: number = 0;

    plugin(): PluginTarget {
        const self = this;
        return this.createStackPlugin({
            visitor: {
                MemberExpression() {
                    self.inc();
                },
                OptionalMemberExpression() {
                    self.inc();
                },
            },
        });
    }

    private inc() {
        assert(this.stack.length > 0);
        const top = this.stack[this.stack.length - 1];

        const current = this.map.get(top) ?? 0;
        this.map.set(top, current + 1);

        // Also track object property accesses in the file total
        this.overall += 1;

        // INVARIANT: this.overall = sum of this.map.values()
        {
            const sum = this.map.values().reduce((acc, x) => acc + x);
            assert(sum === this.overall);
        }
    }
}
