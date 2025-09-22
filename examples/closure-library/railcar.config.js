const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("google-closure-library"),
    oracle: makeInvalidErrorMessageOracle(["Cannot read properties of"]),
};
