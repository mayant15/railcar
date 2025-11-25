const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("ua-parser-js"),
    isBug: makeInvalidErrorMessageOracle([]),
};
