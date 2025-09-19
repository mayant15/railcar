const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("turf"),
    oracle: makeInvalidErrorMessageOracle([
        "units is invalid",
        "First and last",
    ]),
};
