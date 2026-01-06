// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const { FuzzedDataProvider } = require("@railcar/support");
const { Jimp, BlendMode } = require("jimp");
const { writeFileSync } = require("node:fs");

module.exports.fuzz = async function (data) {
    const provider = new FuzzedDataProvider(data);
    const content = provider.consumeBytes(
        provider.consumeIntegralInRange(1, 4096),
    );
    let jimpInput;
    if (provider.consumeBoolean()) {
        jimpInput = Buffer.from(content);
    } else {
        jimpInput = "/tmp/fuzz.me";
        writeFileSync(jimpInput, Buffer.from(content));
    }

    try {
        const image = await Jimp.read(jimpInput);

        const width = provider.consumeIntegralInRange(0, image.bitmap.width);
        const height = provider.consumeIntegralInRange(0, image.bitmap.height);
        const x = provider.consumeIntegralInRange(
            0,
            image.bitmap.width - width,
        );
        const y = provider.consumeIntegralInRange(
            0,
            image.bitmap.height - height,
        );
        const cropImage = image.crop(x, y, width, height);
        const resizeWidth = provider.consumeIntegralInRange(
            0,
            image.bitmap.width,
        );
        const resizeHeight = provider.consumeIntegralInRange(
            0,
            image.bitmap.height,
        );
        const resizeImage = cropImage.resize(resizeWidth, resizeHeight);
        const blurRadius = provider.consumeNumberinRange(0, 100);
        const blurImage = resizeImage.blur(blurRadius);
        const contrastValue = provider.consumeNumberinRange(-1, 1);
        const contrastImage = blurImage.contrast(contrastValue);
        const brightnessValue = provider.consumeNumberinRange(-1, 1);
        const brightnessImage = contrastImage.brightness(brightnessValue);
        const invertImage = brightnessImage.invert();
        const greyscaleImage = invertImage.greyscale();
        const sepiaImage = greyscaleImage.sepia();
        const thresholdValue = provider.consumeNumberinRange(0, 1);
        sepiaImage.threshold(thresholdValue);
        const pixelColorX = provider.consumeIntegralInRange(
            0,
            image.bitmap.width,
        );
        const pixelColorY = provider.consumeIntegralInRange(
            0,
            image.bitmap.height,
        );
        image.getPixelColor(pixelColorX, pixelColorY);

        const kernel = [
            [-1, -1, -1],
            [-1, 9, -1],
            [-1, -1, -1],
        ];
        image.convolution(kernel);

        const bufferType = pickRandom([
            "image/bmp",
            "image/tiff",
            "image/x-ms-bmp",
            "image/gif",
            "image/jpeg",
            "image/png",
        ]);
        image.getBuffer(bufferType);

        const compositeImage = image.clone();
        const compositeX = provider.consumeIntegralInRange(
            0,
            image.bitmap.width,
        );
        const compositeY = provider.consumeIntegralInRange(
            0,
            image.bitmap.height,
        );
        compositeImage.composite(image, compositeX, compositeY, {
            mode: pickRandom([
                BlendMode.SRC_OVER,
                BlendMode.DST_OVER,
                BlendMode.MULTIPLY,
                BlendMode.ADD,
                BlendMode.SCREEN,
                BlendMode.OVERLAY,
                BlendMode.DARKEN,
                BlendMode.LIGHTEN,
                BlendMode.HARD_LIGHT,
                BlendMode.DIFFERENCE,
                BlendMode.EXCLUSION,
            ]),
            opacitySource: provider.consumeNumberinRange(-1, 1),
            opacityDest: provider.consumeNumberinRange(-1, 1),
        });
    } catch {}
};

function pickRandom(array) {
    return array[Math.floor(Math.random() * array.length)];
}
