const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("ua-parser-js"),
    oracle: makeInvalidErrorMessageOracle([]),
};
