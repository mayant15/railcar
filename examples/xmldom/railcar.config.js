const { ParseError } = require("@xmldom/xmldom");

module.exports = {
    instrumentFilter: (f) => f.includes("xmldom"),
    oracle: (err) =>
        typeof err === "object" &&
        (err instanceof TypeError ||
            err instanceof RangeError ||
            err instanceof ParseError),
};
