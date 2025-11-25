const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("d3"),
    isBug: makeInvalidErrorMessageOracle([]),
};
