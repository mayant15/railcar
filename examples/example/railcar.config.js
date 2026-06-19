const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    /** @param {string} */
    shouldInstrument: (f) => f.endsWith("example/index.js"),
    isBug: makeInvalidErrorMessageOracle([]),
    skipMethods: [],
}
