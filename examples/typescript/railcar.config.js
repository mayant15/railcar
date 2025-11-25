const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("typescript"),
    isBug: makeInvalidErrorMessageOracle([
        "maximum call stack size exceeded",
        "host.onunrecoverableconfigfilediagnostic is not a function",
        "cannot",
        "cannot read",
        "cannot create",
        "expected",
        "unexpected",
        "invalid",
        "unterminated",
        "must be",
        "incorrect",
        "stream error",
        "duplicate",
        "the value",
    ]),
    skipMethods: [
        "sys.exit", // terminates the process
        "sys.clearScreen", // writes to stdout, which we're using for IPC
    ],
};
