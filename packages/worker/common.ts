// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Oracle } from "@railcar/support";
import type { SharedExecutionData } from "@railcar/worker-sys";

/**
 * Run a fuzz target with an oracle. Return a boolean that is true
 * if run was ok (no crash).
 */
export function withOracle<I>(
    fuzz: (_: I) => void | Promise<void>,
    oracle: Oracle,
    logError: boolean = false,
    shmem: SharedExecutionData | null = null,
): (_: I) => Promise<boolean> {
    return async (data: I) => {
        try {
            // handles both sync and async functions
            await fuzz(data);
        } catch (err) {
            if (logError) {
                console.error("[RAILCAR_ERROR]", err);
            }

            if (oracle(err)) {
                if (shmem) {
                    shmem.setValid(true);
                }
            } else {
                if (shmem) {
                    shmem.setValid(false);
                }
            }
            return false;
        }

        if (shmem) {
            shmem.setValid(true);
        }
        return true;
    };
}
