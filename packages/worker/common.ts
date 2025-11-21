// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Oracle } from "@railcar/support";
import type { CoverageMap } from "@railcar/worker-sys"

export enum ExitKind {
    Ok = 0,
    Invalid = 1,
    Crash = 2,
    Abort = 3,
}

export function withOracle<I>(
    fuzz: (_: I) => void | Promise<void>,
    oracle: Oracle,
    logError: boolean = false,
    coverage: CoverageMap | null = null
): (_: I) => Promise<ExitKind> {
    return async (data: I) => {
        try {
            // handles both sync and async functions
            await fuzz(data);
        } catch (err) {
            if (logError) {
                console.error("[RAILCAR_ERROR]", err);
            }

            if (oracle(err)) {
                if (coverage) { coverage.setValid(true) }
                return ExitKind.Crash
            } else {
                if (coverage) { coverage.setValid(false) }
                return ExitKind.Invalid
            }
        }

        if (coverage) { coverage.setValid(true) }
        return ExitKind.Ok;
    };
}
