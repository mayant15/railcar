# Railcar

Automatic fuzzing for JavaScript libraries without harnesses.

> Railcar is a research prototype. Expect breaking changes before v1.0.

## Usage

We build and test Railcar on Node 24.6.0 on Linux. Railcar does not support Windows but runs on WSL.
Install Railcar with:
```bash
npm install -D @railcar/cli
```

And then run Railcar with:
```bash
npx railcar entry-point.js
```
where `entry-point.js` is the root of your JavaScript library. See `npx railcar --help` for more
options.

The `examples/` directory includes configuration files to run Railcar on popular projects from
[OSS-Fuzz](https://github.com/google/oss-fuzz). These examples are run periodically with scripts
in `infra/`.

### Schema Inference

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

### Custom Harnesses

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

## Configuration

Railcar allows configuration via a configuration file. By default, it looks for a `railcar.config.js` file
in the current working directory. It allows three options:
```js
module.exports = {
    isBug: (error) => true,
    shouldInstrument: (filename) => true,
    skipMethods: [],
}
```
- `isBug`: A function which receives a thrown value, then decides if it is an actual bug or a false positive.
- `shouldInstrument`: A function that picks which files to instrument for code coverage.
- `skipMethods`: Library APIs to avoid in generated harnesses.

Railcar provides a convenience function for oracles that simply match on error messages.
```javascript
const {makeInvalidErrorMessageOracle} = require("@railcar/support")
module.exports = {
    isBug: makeInvalidErrorMessageOracle(["bad input", /* ... */])
}
```
