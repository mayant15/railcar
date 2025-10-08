const { ParseError } = require("xmldom");

module.exports = {
    instrumentFilter: (f) => f.includes("xmldom"),
    oracle: (err) =>
        err instanceof TypeError ||
        err instanceof RangeError ||
        err instanceof ParseError,
};
