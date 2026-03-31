module.exports = {
    shouldInstrument: (f) => f.includes("angular"),
    isBug: () => false,
    skipMethods: [
        "SECURITY_SCHEMA",
    ]
};
