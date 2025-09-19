// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Oracle } from "@railcar/support";

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
): (_: I) => Promise<ExitKind> {
    return async (data: I) => {
        try {
            // handles both sync and async functions
            await fuzz(data);
        } catch (err) {
            if (logError) {
                console.error("[RAILCAR_ERROR]", err);
            }

            return oracle(err) ? ExitKind.Crash : ExitKind.Invalid;
        }

        return ExitKind.Ok;
    };
}
