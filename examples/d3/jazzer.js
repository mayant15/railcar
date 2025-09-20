// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const d3 = require("d3");

module.exports.fuzz = function (data) {
    d3.csvParse(data.toString());
};
