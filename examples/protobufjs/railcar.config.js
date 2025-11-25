const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    shouldInstrument: (f) => f.includes("protobufjs"),
    isBug: makeInvalidErrorMessageOracle([
        "does not exist",
        "illegal",
        "invalid",
        "must be",
        "duplicate",
        "no such",
        "is not a member of",
        "JSON at position", // passes input string to JSON.parse()
    ]),
    skipMethods: [
        "fetch",
        "util.fetch",
        "Root.fetch",
        "Root.load",
        "load",
        "rpc.Service.rpcCall",
        "util.asPromise",
    ],
};
