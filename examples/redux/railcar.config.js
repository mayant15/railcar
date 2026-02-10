const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("redux"),
    isBug: makeInvalidErrorMessageOracle([]),
    skipMethods: [
        "__DO_NOT_USE__ActionTypes.PROBE_UNKNOWN_ACTION"
    ]
};
