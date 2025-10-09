const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("typescript"),
    oracle: makeInvalidErrorMessageOracle([
        "maximum call stack size exceeded",
        "expected",
        "unexpected",
        "invalid",
        "cannot",
        "unterminated",
        "must be",
        "incorrect",
        "stream error",
        "duplicate",
        "the value",
    ]),
};
