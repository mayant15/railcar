module.exports = {
    instrumentFilter: (f) => f.includes("ua-parser-js"),
    oracle: () => true,
};
