const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("canvg"),
    isBug: makeInvalidErrorMessageOracle([
        "Cannot read properties",
        "Cannot set properties",
        "Attribute class redefined",
        "Expected positive number",
        "Unterminated command",
        "Unexpected character",
        "Attribute height redefined",
        "Attribute",
        "Invalid number ending",
        "Expected a flag",
        "end tag name",
    ]),
};
