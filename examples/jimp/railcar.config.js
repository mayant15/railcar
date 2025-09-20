const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("jimp"),
    oracle: makeInvalidErrorMessageOracle([]),
};
