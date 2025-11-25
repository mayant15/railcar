const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("redux"),
    isBug: makeInvalidErrorMessageOracle([]),
};
