const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("tslib"),
    isBug: makeInvalidErrorMessageOracle(["Class extends value"]),
    skipMethods: ["__read"],
};
