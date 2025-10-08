// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const { FuzzedDataProvider } = require("@railcar/support");
const jpeg = require("jpeg-js");

module.exports.fuzz = function (data) {
    const provider = new FuzzedDataProvider(data);
    jpeg.decode(
        provider.consumeBytes(provider.consumeIntegralInRange(0, 2 ** 48 - 1)),
        {
            useTArray: provider.consumeBoolean(),
            colorTransform: provider.consumeBoolean(),
            formatAsRGBA: provider.consumeBoolean(),
            tolerantDecoding: provider.consumeBoolean(),
        },
    );
};
