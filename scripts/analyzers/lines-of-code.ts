/**
 * Counts the number of lines of code in a function.
 *
 * Unused for now, because it counts raw (end.line - start.line + 1),
 * which includes comments. Since we already have location information,
 * we just do this in SQL instead.
 *
 * This would be useful if we could skip comments and whitespace. But for
 * now I couldn't find decent documentation on how to do that with Babel.
 */

import assert from "node:assert";
import type { NodePath, PluginTarget } from "@babel/core";
import type {
    Function as BabelFunction,
    Program,
    SourceLocation,
} from "@babel/types";
import { FunctionStackAnalysis } from "./function-stack-analysis";

export class LinesOfCodeAnalysis extends FunctionStackAnalysis<number> {
    plugin(): PluginTarget {
        const self = this;
        return this.createStackPlugin({
            visitor: {
                Program(path: NodePath<Program>) {
                    self.record(path.node.loc);
                },
                Function(path: NodePath<BabelFunction>) {
                    self.record(path.node.loc);
                },
            },
        });
    }

    private record(loc: SourceLocation | null | undefined) {
        assert(loc !== null);
        assert(loc !== undefined);
        const lines = loc.end.line - loc.start.line + 1;

        assert(this.stack.length > 0);
        const top = this.stack[this.stack.length - 1];

        assert(!this.map.has(top));
        this.map.set(top, lines);
    }
}
