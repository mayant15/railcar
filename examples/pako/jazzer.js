// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const { FuzzedDataProvider } = require('@jazzer.js/core');
const pako = require("pako");

module.exports.fuzz = function(data) {
  const fdp = new FuzzedDataProvider(data);
  const choice = fdp.consumeBoolean();

  try {
    if (choice === true) {
      const comprLevel = fdp.consumeIntegral(1);
      const windowBits = fdp.consumeIntegral(1);
      const memLevel = fdp.consumeIntegral(1);
      const strategy = fdp.consumeIntegral(1);
      const raw = fdp.consumeBoolean();
      const input = new Uint8Array(fdp.consumeRemainingAsBytes());
      const options = {
        level: comprLevel,
        windowBits: windowBits,
        memLevel: memLevel,
        strategy: strategy,
        raw: raw
      };
      const defl = pako.deflate(input, options);
      pako.inflate(defl, options);
      const deflRaw = pako.deflateRaw(input, options);
      pako.inflateRaw(deflRaw, options);
    } else {
      const gzipOptions = {
        level: fdp.consumeIntegral(1),
        raw: fdp.consumeBoolean(),
        to: fdp.consumeBoolean(),
        windowBits: fdp.consumeIntegral(1),
        memLevel: fdp.consumeIntegral(1),
        strategy: fdp.consumeIntegral(1)
      };
      const input = new Uint8Array(fdp.consumeRemainingAsBytes());
      const gzip = pako.gzip(input, gzipOptions);
      pako.ungzip(gzip, gzipOptions);
      pako.inflate(gzip);
      pako.inflateRaw(gzip);
    }
  } catch (error) {
    if (error.message && !ignoredError(error)) {
      throw error;
    }
  }
};

function ignoredError(error) {
  return !!ignored.find((message) => error.message.indexOf(message) !== -1);
}

const ignored = [
  'stream error',
  'invalid window size',
  'incorrect header check'
];
