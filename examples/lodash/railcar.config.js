const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("lodash"),
    oracle: makeInvalidErrorMessageOracle([
        "min must be less than or equal to max",
        "unexpected token",
        "is not defined",
        "invalid or unexpected",
    ]),
};
