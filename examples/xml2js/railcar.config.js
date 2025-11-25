module.exports = {
    shouldInstrument: (f) => f.includes("xml2js"),
    isBug: () => false,
};
