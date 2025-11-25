const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("turf"),
    isBug: makeInvalidErrorMessageOracle([
        "units is invalid",
        "First and last",
    ]),
};
