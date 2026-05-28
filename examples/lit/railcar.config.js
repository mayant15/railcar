const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("node_modules/lit") || f.includes("node_modules/@lit"),
    isBug: makeInvalidErrorMessageOracle(["Cannot read properties"]),
    skipMethods: [
        "ReactiveElement.scheduleUpdate",
        "ReactiveElement.requestUpdate",
    ],
};
