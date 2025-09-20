const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("promise-polyfill"),
    oracle: makeInvalidErrorMessageOracle([]),
};
