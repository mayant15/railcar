// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const { FuzzedDataProvider } = require("@railcar/support");
const Jimp = require("jimp");
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

    Jimp.read(jimpInput, (err, image) => {
        if (err) return;

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
        const hueValue = provider.consumeNumberinRange(-1, 1);
        const hueImage = brightnessImage.hue(hueValue);
        const invertImage = hueImage.invert();
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
        const fontPath = pickRandom([
            provider.consumeString(128),
            Jimp.FONT_SANS_8_BLACK,
            Jimp.FONT_SANS_10_BLACK,
            Jimp.FONT_SANS_12_BLACK,
            Jimp.FONT_SANS_14_BLACK,
            Jimp.FONT_SANS_16_BLACK,
            Jimp.FONT_SANS_32_BLACK,
            Jimp.FONT_SANS_64_BLACK,
            Jimp.FONT_SANS_128_BLACK,
            Jimp.FONT_SANS_8_WHITE,
            Jimp.FONT_SANS_16_WHITE,
            Jimp.FONT_SANS_32_WHITE,
            Jimp.FONT_SANS_64_WHITE,
            Jimp.FONT_SANS_128_WHITE,
        ]);
        const fontColor = provider.consumeNumber();
        const fontSize = provider.consumeIntegralInRange(0, 100);
        const fontX = provider.consumeIntegralInRange(0, image.bitmap.width);
        const fontY = provider.consumeIntegralInRange(0, image.bitmap.height);
        const text = provider.consumeString(10);
        Jimp.loadFont(fontPath).then((font) => {
            image.print(font, fontX, fontY, text, fontSize, fontColor);
        });

        const color = Jimp.color([
            provider.consumeIntegralInRange(0, 256),
            provider.consumeIntegralInRange(0, 256),
            provider.consumeIntegralInRange(0, 256),
            provider.consumeIntegralInRange(0, 256),
        ]);
        image.color([
            { apply: "hue", params: [provider.consumeNumberinRange(-1, 1)] },
            {
                apply: "lighten",
                params: [provider.consumeNumberinRange(-1, 1)],
            },
            {
                apply: "saturate",
                params: [provider.consumeNumberinRange(-1, 1)],
            },
            {
                apply: "mix",
                params: [color, provider.consumeNumberinRange(0, 1)],
            },
        ]);

        const filterType = pickRandom([
            Jimp.AUTO,
            Jimp.BLUR,
            Jimp.SHARPEN,
            Jimp.EDGE_DETECT,
            Jimp.EMBOSS,
            Jimp.GAUSSIAN,
        ]);
        image.filter(filterType);

        const kernel = [
            [-1, -1, -1],
            [-1, 9, -1],
            [-1, -1, -1],
        ];
        image.convolution(kernel);

        const bufferType = pickRandom([
            Jimp.MIME_PNG,
            Jimp.MIME_JPEG,
            Jimp.MIME_BMP,
            Jimp.MIME_TIFF,
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
                Jimp.BLEND_SOURCE_OVER,
                Jimp.BLEND_DESTINATION_OVER,
                Jimp.BLEND_MULTIPLY,
                Jimp.BLEND_ADD,
                Jimp.BLEND_SCREEN,
                Jimp.BLEND_OVERLAY,
                Jimp.BLEND_DARKEN,
                Jimp.BLEND_LIGHTEN,
                Jimp.BLEND_HARDLIGHT,
                Jimp.BLEND_DIFFERENCE,
                Jimp.BLEND_EXCLUSION,
            ]),
            opacitySource: provider.consumeNumberinRange(-1, 1),
            opacityDest: provider.consumeNumberinRange(-1, 1),
        });

        const backgroundColor = Jimp.color([
            provider.consumeIntegralInRange(0, 256),
            provider.consumeIntegralInRange(0, 256),
            provider.consumeIntegralInRange(0, 256),
            provider.consumeIntegralInRange(0, 256),
        ]);
        const backgroundX = provider.consumeIntegralInRange(
            0,
            image.bitmap.width,
        );
        const backgroundY = provider.consumeIntegralInRange(
            0,
            image.bitmap.height,
        );
        const backgroundWidth = provider.consumeIntegralInRange(
            0,
            image.bitmap.width - backgroundX,
        );
        const backgroundHeight = provider.consumeIntegralInRange(
            0,
            image.bitmap.height - backgroundY,
        );
        image.background(
            backgroundColor,
            backgroundX,
            backgroundY,
            backgroundWidth,
            backgroundHeight,
        );
    });
};

function pickRandom(array) {
    return array[Math.floor(Math.random() * array.length)];
}
