// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const { FuzzedDataProvider } = require("@jazzer.js/core");
const jpeg = require("jpeg-js");

module.exports.fuzz = function (data) {
    const provider = new FuzzedDataProvider(data);

    try {
        jpeg.decode(
            provider.consumeBytes(
                provider.consumeIntegralInRange(0, 2 ** 48 - 1),
            ),
            {
                useTArray: provider.consumeBoolean(),
                colorTransform: provider.consumeBoolean(),
                formatAsRGBA: provider.consumeBoolean(),
                tolerantDecoding: provider.consumeBoolean(),
            },
        );
    } catch (error) {
        // Catch all errors to find more critical bugs.
    }
};
