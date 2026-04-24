const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("angular"),
    isBug: makeInvalidErrorMessageOracle([]),
    skipMethods: [
        "SECURITY_SCHEMA",
    ]
};
