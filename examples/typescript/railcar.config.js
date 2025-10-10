const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("typescript"),
    oracle: makeInvalidErrorMessageOracle([
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
};
