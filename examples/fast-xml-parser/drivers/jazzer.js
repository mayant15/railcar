// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0

const { FuzzedDataProvider } = require("@jazzer.js/core");
const XMLParser = require("../src/src/xmlparser/XMLParser");
const XMLBuilder = require("../src/src/xmlbuilder/json2xml");
const XMLValidator = require("../src/src/fxp").XMLValidator;

module.exports.fuzz = (data) => {
    try {
        const provider = new FuzzedDataProvider(data);
        const xmlString = provider.consumeString(1024);
        const parser = new XMLParser();
        const jObj = parser.parse(xmlString);
        const builder = new XMLBuilder();
        const xmlContent = builder.build(jObj);

        XMLValidator.validate(xmlContent, {
            allowBooleanAttributes: true,
        });
    } catch (error) {
        if (!ignoredError(error)) throw error;
    }
};

function ignoredError(error) {
    return !!ignored.find((message) => error.message.indexOf(message) !== -1);
}

const ignored = ["Cannot read properties", "is not closed", "Invalid Tag"];
