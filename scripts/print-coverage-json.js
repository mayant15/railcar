/**
 * Read a coverage-*.json and print coverage for a file.
 *
 * Usage:
 *   print-coverage-json.js <json-path> [file-filter]
 */

import fs from "node:fs";

const json = JSON.parse(fs.readFileSync(process.argv[2]));
const file = process.argv[3] ?? "test.js";

const data = json.result
    .filter((r) => r.url.includes(file))
    .flatMap((r) => r.functions)
    .flatMap((f) => f.ranges);

console.log(data);
