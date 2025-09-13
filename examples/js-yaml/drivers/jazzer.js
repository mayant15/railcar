// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const { FuzzedDataProvider } = require("@jazzer.js/core");
const yaml = require("../src");

module.exports.fuzz = function (data) {
    const provider = new FuzzedDataProvider(data);
    const loadOptions = generateRandomLoadOptions(provider);
    const dumpOptions = generateRandomDumpOptions(provider);
    const yamlString = provider.consumeRemainingAsString();

    try {
        const parsedYaml = yaml.load(yamlString, loadOptions);
        const _serializedYaml = yaml.dump(parsedYaml, dumpOptions);
    } catch (e) {
        if (!(e instanceof yaml.YAMLException)) {
            throw e;
        }
    }
};

function generateRandomLoadOptions(provider) {
    const options = {};
    options.schema = getSchema(provider.consumeIntegralInRange(0, 3));
    options.json = provider.consumeBoolean();
    return options;
}

function generateRandomDumpOptions(provider) {
    const options = {};
    options.indent = provider.consumeIntegralInRange(0, 4096);
    options.skipInvalid = provider.consumeBoolean();
    options.flowLevel = provider.consumeIntegralInRange(-1, 100);
    options.schema = getSchema(provider.consumeIntegralInRange(0, 3));
    options.sortKeys = provider.consumeBoolean();
    options.lineWidth = provider.consumeIntegralInRange(0, 4096);
    options.noRefs = provider.consumeBoolean();
    options.noCompatMode = provider.consumeBoolean();
    options.condenseFlow = provider.consumeBoolean();
    options.forceQuotes = provider.consumeBoolean();
    return options;
}

function getSchema(number) {
    switch (number) {
        case 0:
            return yaml.DEFAULT_SCHEMA;
        case 1:
            return yaml.FAILSAFE_SCHEMA;
        case 2:
            return yaml.JSON_SCHEMA;
        case 3:
            return yaml.CORE_SCHEMA;
    }
}
