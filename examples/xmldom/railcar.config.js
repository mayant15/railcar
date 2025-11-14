/**
 * CAUTION! This script is loaded *before* instrumentation hooks are loaded.
 * A require('@xmldom/xmldom') here would import and cache all modules, and later
 * imports would not trigger hooks (so the module stays uninstrumented).
 *
 * We need access to ParseError from xmldom but we cannot import it. As a workaround,
 * compare constructor names for now.
 */

module.exports = {
    instrumentFilter: (f) => f.includes("xmldom"),
    oracle: (err) =>
        typeof err === "object" &&
        (err instanceof TypeError ||
            err instanceof RangeError ||
            err.constructor.name === "ParseError")
};
