import { FuzzedDataProvider as DataProvider } from "./FuzzedDataProvider";

export class FuzzedDataProvider extends DataProvider {
    constructor(data: Uint8Array) {
        super(Buffer.from(data));
    }
}

export type Oracle = (err: unknown) => boolean;

export type Config = Partial<ValidatedConfig>;

type ValidatedConfig = {
    oracle: Oracle;
    instrumentFilter: (_: string) => boolean;
    methodsToSkip: string[];
};

export function makeRailcarConfig(config: Config): ValidatedConfig {
    return {
        oracle: config.oracle ?? makeInvalidErrorMessageOracle([]),
        instrumentFilter: config.instrumentFilter ?? defaultInstrumentFilter,
        methodsToSkip: config.methodsToSkip ?? [],
    };
}

function defaultInstrumentFilter(filename: string): boolean {
    return !filename.includes("node_modules");
}

const STD_ERRORS = [
    "Invalid typed array length",
    "Invalid flags supplied to RegExp constructor",
    "Invalid regular expression",
];

/**
 * @param {string[]} messages Error messages that are *not* bugs
 */
export function makeInvalidErrorMessageOracle(messages: string[]): Oracle {
    const errorSet = [...messages, ...STD_ERRORS];
    return (err) => {
        if (err instanceof TypeError) return false;
        if (err instanceof RangeError) return false;

        const msg =
            typeof err === "string"
                ? err
                : err instanceof Error
                  ? err.message
                  : undefined;

        if (msg && shouldIgnore(msg, errorSet)) {
            return false;
        }

        return true;
    };
}

function shouldIgnore(error: string, ignored: string[]) {
    return !!ignored.find(
        (msg) => msg === "RAILCAR_IGNORE_ALL" || error.indexOf(msg) !== -1,
    );
}
