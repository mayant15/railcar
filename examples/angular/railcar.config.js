module.exports = {
    shouldInstrument: (f) => f.includes("angular"),
    isBug: () => false,
};
