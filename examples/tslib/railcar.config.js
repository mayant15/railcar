const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("tslib"),
    oracle: makeInvalidErrorMessageOracle(["Class extends value"]),
};
