const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("jpeg-js"),
    isBug: makeInvalidErrorMessageOracle([]),
};
