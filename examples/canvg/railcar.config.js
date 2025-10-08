const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("canvg"),
    oracle: makeInvalidErrorMessageOracle([
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
