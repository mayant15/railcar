// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert";

import type { Oracle } from "@railcar/support";
import type { SharedExecutionData } from "@railcar/worker-sys";

import { ExitKind, withOracle } from "./common.js";

export class BytesExecutor {
    _executor: (bytes: Uint8Array) => Promise<ExitKind> = (_) =>
        Promise.resolve(ExitKind.Ok);
    _shmem: SharedExecutionData | null = null;

    constructor(shmem: SharedExecutionData | null) {
        this._shmem = shmem;
    }

    async init(mainModule: string, oracle: Oracle, logError = false) {
        const { fuzz } = await import(mainModule);
        assert(typeof fuzz === "function");
        this._executor = withOracle(fuzz, oracle, logError, this._shmem);
    }

    async execute(bytes: Uint8Array) {
        return this._executor(bytes);
    }
}
