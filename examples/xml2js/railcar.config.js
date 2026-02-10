module.exports = {
    shouldInstrument: (f) => f.includes("xml2js"),
    isBug: () => false,
    skipMethods: [
        "Parser.processAsync",
        "Parser.assignOrPush",
        "Parser.EventEmitter",
        "Parser.EventEmitterAsyncResource",
        "Parser.init",
    ]
};
