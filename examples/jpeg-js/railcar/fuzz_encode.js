// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const { FuzzedDataProvider } = require("@railcar/support");
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

    var jpegImageData = jpeg.encode(rawImageData, quality);
};
