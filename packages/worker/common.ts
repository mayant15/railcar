// SPDX-License-Identifier: AGPL-3.0-or-later

export enum ExitKind {
    Ok = 0,
    Invalid = 1,
    Crash = 2,
    Abort = 3,
}

export function withOracle<I>(
    fuzz: (_: I) => void | Promise<void>,
    ignored: string[],
    _logError: boolean = false,
): (_: I) => Promise<ExitKind> {
    return async (data: I) => {
        try {
            // handles both sync and async functions
            await fuzz(data);
        } catch (err) {
            if (err instanceof TypeError) {
                return ExitKind.Invalid;
            }

            if (err instanceof RangeError) {
                return ExitKind.Invalid;
            }

            const message =
                typeof err === "string"
                    ? err
                    : err instanceof Error
                      ? err.message
                      : undefined;

            if (message) {
                if (ignoredError(message, ignored)) {
                    return ExitKind.Invalid;
                }

                if (message.indexOf("unreachable") !== -1) {
                    return ExitKind.Abort;
                }
            }

            console.error("[RAILCAR_ERROR]", err);
            return ExitKind.Crash;
        }
        return ExitKind.Ok;
    };
}

function ignoredError(error: string, ignored: string[]) {
    const ignore = !!ignored.find(
        (message) =>
            message === "RAILCAR_IGNORE_ALL" || error.indexOf(message) !== -1,
    );
    return ignore;
}
