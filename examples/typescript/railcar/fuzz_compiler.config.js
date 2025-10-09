const { makeInvalidErrorMessageOracle } = require("@railcar/support");

module.exports = {
    instrumentFilter: (f) => f.includes("typescript"),
    oracle: makeInvalidErrorMessageOracle([
        "maximum call stack size exceeded",
        "host.onunrecoverableconfigfilediagnostic is not a function",
    ]),
};
