module.exports = {
    shouldInstrument: (f) => f.includes("jpeg-js"),
    isBug: () => false,
};
