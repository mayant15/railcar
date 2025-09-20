// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Modified to support Railcar instead of Jazzer.js

const d3 = require("d3");

module.exports.fuzz = function (data) {
    d3.csvParse(data.toString());
};
