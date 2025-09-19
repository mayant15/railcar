const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("pako"),
    oracle: makeInvalidErrorMessageOracle([
        "need dictionary",
        "stream error",
        "buffer error",
        "data error",
        "invalid",
        "incorrect",
        "unknown",
        "header crc mismatch",
        "too many length or distance symbols",
    ]),
};
