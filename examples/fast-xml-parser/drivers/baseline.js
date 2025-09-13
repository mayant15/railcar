// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const { FuzzedDataProvider } = require("@railcar/support");
const { XMLParser, XMLBuilder, XMLValidator } = require("../src");

module.exports.fuzz = (data) => {
    const provider = new FuzzedDataProvider(data);
    const xmlString = provider.consumeString(1024);
    const parser = new XMLParser();
    const jObj = parser.parse(xmlString);
    const builder = new XMLBuilder();
    const xmlContent = builder.build(jObj);

    XMLValidator.validate(xmlContent, {
        allowBooleanAttributes: true,
    });
};
