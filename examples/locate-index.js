const assert = require("node:assert");

const file = process.argv[2];
assert(!!file);
assert(typeof file === "string");
assert(file.length > 0);

console.log(require.resolve(file));
