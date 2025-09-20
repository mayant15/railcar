const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("d3"),
    oracle: makeInvalidErrorMessageOracle([]),
};
