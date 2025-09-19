// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import { ExitKind, withOracle } from "./common";
import type { Oracle } from "@railcar/support";

export class BytesExecutor {
    _executor: (bytes: Uint8Array) => Promise<ExitKind> = (_) =>
        Promise.resolve(ExitKind.Ok);

    async init(mainModule: string, oracle: Oracle, logError = false) {
        const { fuzz } = await import(mainModule);
        assert(typeof fuzz === "function");
        this._executor = withOracle(fuzz, oracle, logError);
    }

    async execute(bytes: Uint8Array) {
        return this._executor(bytes);
    }
}
