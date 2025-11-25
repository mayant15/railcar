const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("lodash"),
    isBug: makeInvalidErrorMessageOracle([
        "min must be less than or equal to max",
        "unexpected token",
        "is not defined",
        "invalid or unexpected",
    ]),
};
