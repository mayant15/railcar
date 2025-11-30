# Usage

```bash
npx railcar entry-point.js
```
where `entry-point.js` is the root of your JavaScript library. See `npx railcar --help` for more
options.

The `examples/` directory includes configuration files to run Railcar on popular projects from
[OSS-Fuzz](https://github.com/google/oss-fuzz). These examples are run periodically with scripts
in `infra/`.

## Schema Inference

Railcar relies on _library schemas_. A schema is a list of library APIs, along with their possible
argument and return types. Railcar can guess a schema at run-time (assuming mostly `any` types), but
can be more effective when given a precise set of types to work with.

If a TypeScript `.d.ts` file is available for your library, Railcar includes an inference tool
that can generate a schema.
```bash
npx railcar-infer --decl <file> # writes to stdout by default
```

Then use this schema with Railcar like so:
```bash
npx railcar --schema <schema-file> <entrypoint>
```

See `npx railcar-infer --help` for more options.

## Custom Harnesses

Railcar allows running custom harnesses when available:
```bash
npx railcar --mode bytes harness.js
```
Here `harness.js` is a module that exports your harness as a function `fuzz: (bytes: Uint8Array) => void`.

Railcar provides an optional library, `@railcar/support` which exports a `FuzzedDataProvider` (from [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer))
for use in harnesses.
```bash
npm install -D @railcar/support
```
```javascript
const {FuzzedDataProvider} = require("@railcar/support")
module.exports.fuzz = bytes => {
    const provider = new FuzzedDataProvider(bytes)
    // ...
}
```
