const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("pako"),
    isBug: makeInvalidErrorMessageOracle([
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
