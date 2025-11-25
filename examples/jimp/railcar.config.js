const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("jimp"),
    isBug: makeInvalidErrorMessageOracle([]),
};
