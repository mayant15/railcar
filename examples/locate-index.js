import assert from "node:assert";

const file = process.argv[2];
assert(!!file);
assert(typeof file === "string");
assert(file.length > 0);

console.log(new URL(import.meta.resolve(file)).pathname);
