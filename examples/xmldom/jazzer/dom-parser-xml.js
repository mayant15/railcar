// SPDX-FileCopyrightText: 2012 - 2017 @jindw <jindw@xidea.org> and other contributors, as listed in: https://github.com/jindw/xmldom/graphs/contributors
// SPDX-FileCopyrightText: 2019 - present Christopher J. Brody and other contributors, as listed in: https://github.com/xmldom/xmldom/graphs/contributors
// SPDX-License-Identifier: MIT

"use strict";

const { DOMParser, ParseError, MIME_TYPE, XMLSerializer } = require("@xmldom/xmldom");

module.exports.fuzz = (buffer) => {
    try {
        const parsed = new DOMParser({
            errorHandler: (level, message) => {
                if (
                    level === "error" &&
                    message.startsWith("element parse error: ")
                ) {
                    throw new Error(message);
                }
            },
        }).parseFromString(buffer.toString(), MIME_TYPE.XML_TEXT);
        new XMLSerializer().serializeToString(parsed);
    } catch (error) {
        if (error instanceof ParseError) return -1;
        throw error;
    }
};
