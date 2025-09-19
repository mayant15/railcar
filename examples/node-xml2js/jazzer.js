// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const { FuzzedDataProvider } = require("@jazzer.js/core");
const xml2js = require("xml2js");

module.exports.fuzz = async function (data) {
    // async? --sync will have oom
    const provider = new FuzzedDataProvider(data);
    let xml = provider.consumeString(
        provider.consumeIntegralInRange(0, 2 ** 48 - 1),
    );

    var options = {
        attrkey: provider.consumeString(
            provider.consumeIntegralInRange(0, 2 ** 48 - 1),
        ),
        charkey: provider.consumeString(
            provider.consumeIntegralInRange(0, 2 ** 48 - 1),
        ),
        explicitCharkey: provider.consumeBoolean(),
        trim: provider.consumeBoolean(),
        normalizeTags: provider.consumeBoolean(),
        normalize: provider.consumeBoolean(),
        explicitRoot: provider.consumeNumber(),
        emptyTag: provider.consumeString(
            provider.consumeIntegralInRange(0, 2 ** 48 - 1),
        ),
        explicitArray: provider.consumeBoolean(),
        ignoreAttrs: provider.consumeBoolean(),
        mergeAttrs: provider.consumeBoolean(),
        xmlns: provider.consumeBoolean(),
        explicitChildren: provider.consumeBoolean(),
        childkey: provider.consumeString(
            provider.consumeIntegralInRange(0, 2 ** 48 - 1),
        ),
        preserveChildrenOrder: provider.consumeBoolean(),
        charsAsChildren: provider.consumeBoolean(),
        includeWhiteChars: provider.consumeBoolean(),
        async: provider.consumeBoolean(),
        strict: provider.consumeBoolean(),
    };

    var parser = new xml2js.Parser(options);
    try {
        parser.parseString(xml);
        parser
            .parseStringPromise(xml)
            .then(function () {})
            .catch(function () {});
    } catch (error) {
        // Catch expected errors to find more interesting bugs.
    }
};
