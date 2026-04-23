const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("xml2js"),
    isBug: makeInvalidErrorMessageOracle([]),
    skipMethods: [
        "Parser.processAsync",
        "Parser.assignOrPush",
        "Parser.EventEmitter",
        "Parser.EventEmitterAsyncResource",
        "Parser.init",
    ]
};
