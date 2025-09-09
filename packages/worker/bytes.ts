// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import { ExitKind, withOracle } from "./common";

export class BytesExecutor {
    _executor: (bytes: Uint8Array) => Promise<ExitKind> = (_) =>
        Promise.resolve(ExitKind.Ok);

    async init(mainModule: string, ignored: string[], logError = false) {
        const { fuzz } = await import(mainModule);
        assert(typeof fuzz === "function");
        this._executor = withOracle(fuzz, ignored, logError);
    }

    async execute(bytes: Uint8Array) {
        return this._executor(bytes);
    }
}
