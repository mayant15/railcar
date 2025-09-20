// SPDX-FileCopyrightText: 2023 Google LLC
// SPDX-License-Identifier: Apache-2.0
// Imports modified to integrate with Railcar's examples file tree

const Promise = require("promise-polyfill");

module.exports.fuzz = async function (data) {
    try {
        const promise = new Promise((resolve, reject) => {
            if (data.toString() === "reject") {
                reject(new Error("rejected"));
            } else {
                resolve(data.toString());
            }
        });

        promise
            .then(
                (result) => {
                    Promise.resolve("");
                    result.toUpperCase();
                },
                (_error) => {},
            )
            .catch((_error) => {})
            .finally(() => {});

        Promise.resolve(data.toString())
            .then(
                (result) => {
                    result.toUpperCase();
                },
                (_error) => {},
            )
            .catch((_error) => {})
            .finally(() => {});

        Promise.reject(new Error("rejected"))
            .catch((_error) => {})
            .finally(() => {});

        const promises = [
            Promise.resolve(data.toString()),
            Promise.reject(new Error("rejected")),
            Promise.resolve(data.toString()),
        ];
        Promise.all(promises)
            .then(
                (_results) => {
                    Promise.resolve("");
                },
                (_error) => {},
            )
            .catch((_error) => {})
            .finally(() => {});

        Promise.race(promises)
            .then(
                (_result) => {
                    Promise.resolve("");
                },
                (_error) => {},
            )
            .catch((_error) => {})
            .finally(() => {});
    } catch (error) {
        if (!ignoredError(error)) throw error;
    }
};

function ignoredError(error) {
    return !!ignored.find((message) => error.message.indexOf(message) !== -1);
}

const ignored = [];
