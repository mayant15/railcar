// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const { FuzzedDataProvider } = require("@jazzer.js/core");
const { XMLParser, XMLBuilder, XMLValidator } = require("../src");

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
