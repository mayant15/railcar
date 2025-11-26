const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("lit"),
    isBug: makeInvalidErrorMessageOracle(["Cannot read properties"]),
    skipMethods: [
        "ReactiveElement.scheduleUpdate",
        "ReactiveElement.requestUpdate",
    ],
};
