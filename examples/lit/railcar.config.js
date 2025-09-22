const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("lit"),
    oracle: makeInvalidErrorMessageOracle(["Cannot read properties"]),
};
