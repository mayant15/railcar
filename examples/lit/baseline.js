// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const { FuzzedDataProvider } = require("@railcar/support");
const { LitElement, html } = require("lit");

module.exports.fuzz = function(data) {
    const provider = new FuzzedDataProvider(data);
    const element = new LitElement();
    const properties = {};
    const numProperties = provider.consumeIntegralInRange(0, 32);
    const template = provider.consumeString(
      provider.consumeIntegralInRange(0, 4096)
    );

    for (let i = 0; i < numProperties; i++) {
      const key = provider.consumeString(32);
      let value;
      switch (provider.consumeIntegralInRange(0, 7)) {
        case 0:
          value = provider.consumeBoolean();
          break;
        case 1:
          value = provider.consumeIntegralInRange(0, 2 ** 48 - 1);
          break;
        case 2:
          value = provider.consumeIntegralInRange(-(2 ** 48 - 1), 0);
          break;
        case 3:
          value = provider.consumeString(
            provider.consumeIntegralInRange(0, 256)
          );
          break;
        case 4:
          value = provider.consumeFloat();
          break;
        case 5:
          value = provider.consumeDouble();
          break;
        case 6:
          const isSigned = provider.consumeBoolean();
          value = provider.consumeBigIntegral(8, isSigned);
          break;
        default:
          value = null;
      }
      properties[key] = value;
    }

    element.render(html`${template}`);
    element.update(properties);

    const attributeName = provider.consumeString(
      provider.consumeIntegralInRange(0, 128)
    );
    const attributeValue = provider.consumeString(
      provider.consumeIntegralInRange(0, 128)
    );
    element.attributeChangedCallback(attributeName, null, attributeValue);
    element.connectedCallback();
    element.disconnectedCallback();
    element.shouldUpdate(properties);

    const propKey = provider.consumeString(
      provider.consumeIntegralInRange(0, 256)
    );
    const attrKey = provider.consumeString(
      provider.consumeIntegralInRange(0, 256)
    );
    const propValue = provider.consumeString(
      provider.consumeIntegralInRange(0, 256)
    );
    const attrValue = provider.consumeString(
      provider.consumeIntegralInRange(0, 256)
    );

    Object.defineProperty(element, propKey, {
      get() {
        return propValue;
      },
      set(value) {
        propValue = value;
      },
    });

    element.setAttribute(attrKey, attrValue);
};
