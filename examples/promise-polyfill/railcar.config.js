const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("promise-polyfill"),
    isBug: makeInvalidErrorMessageOracle([]),
};
