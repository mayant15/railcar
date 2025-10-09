const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("protobufjs"),
    oracle: makeInvalidErrorMessageOracle([
        "does not exist",
        "illegal",
        "invalid",
        "must be",
        "duplicate",
        "no such",
        "is not a member of",
        "JSON at position", // passes input string to JSON.parse()
    ]),
    methodsToSkip: [
        "fetch",
        "util.fetch",
        "Root.fetch",
        "Root.load",
        "load",
        "rpc.Service.rpcCall",
        "util.asPromise",
    ],
};
