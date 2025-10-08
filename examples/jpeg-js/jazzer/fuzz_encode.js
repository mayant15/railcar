// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const { FuzzedDataProvider } = require("@jazzer.js/core");
const jpeg = require("jpeg-js");

module.exports.fuzz = function (data) {
    const provider = new FuzzedDataProvider(data);

    var width = provider.consumeIntegralInRange(0, 2 ** 48 - 1),
        height = provider.consumeIntegralInRange(0, 2 ** 48 - 1),
        quality = provider.consumeIntegralInRange(0, 2 ** 48 - 1);
    var frameData = provider.consumeRemainingAsBytes();
    var rawImageData = {
        data: frameData,
        width: width,
        height: height,
    };

    try {
        var jpegImageData = jpeg.encode(rawImageData, quality);
    } catch (error) {
        // Catch all errors to find critical bugs.
    }
};
