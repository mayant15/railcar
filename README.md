# Railcar

Automatic fuzzing for JavaScript libraries without harnesses.

> Railcar is a research prototype. Expect breaking changes before v1.0.

## Installation

Railcar has been developed and tested for Node 24.6.0 on Linux. Railcar does not support Windows.
```
npm install -D @railcar/cli
```

## Usage

```
npx railcar entry-point.js
```
where `entry-point.js` is the root of your JavaScript library. See `npx railcar --help` for more details.

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
Here `harness.js` is a module that exports your harness as a function `fuzz(bytes: Uint8Array): void`.

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
    oracle: (error) => true,
    instrumentFilter: (filename) => true,
    methodsToSkip: [],
}
```
- `oracle`: A function which receives a thrown value, then decides if it is an actual bug or a false positive.
- `instrumentFilter`: A function that picks which files to instrument for code coverage
- `methodsToSkip`: Library APIs to avoid in generated harnesses

Railcar provides a convenience function for oracles that simple match or error messages.
```javascript
const {makeInvalidErrorMessageOracle} = require("@railcar/support")
module.exports = {
    oracle = makeInvalidErrorMessageOracle([
      "bad input",
      // ...
    ])
}
```

## Developing

We use [`mise`](https://mise.jdx.dev/) to manage dependencies and run scripts. Building Railcar also requires a working C compiler,
not managed by `mise`.

In the Railcar directory, run:
```
mise setup
mise build
```
See `mise.toml` for more scripts.

During development, run Railcar with cargo:
```bash
cargo run --release --bin railcar -- entry-point.js
```

### Packages

Railcar is a collection of Rust and TypeScript packages.
- `cli/`: Main CLI tool that spawns all child processes. Rust.
- `worker/`: Main executor and instrumentation, running in the Node.js child process. TypeScript.
- `graph/`: Core data structures for graphs. Rust.
- `inference/`: Dynamic and static schema inference, including `railcar-infer`. TypeScript.
- `metrics/`: Support functions for tracking fuzzer metrics. Rust.
- `support/`: Support functions for end users. TypeScript.
- `tools/`: Small CLI utilities useful for development and debugging. Rust.
- `worker-sys/`: Native utility functions for `@railcar/worker`. Rust.

### Examples

The `examples/` directory includes configuration files and scripts to run Railcar on popular
projects from [OSS-Fuzz](https://github.com/google/oss-fuzz). These examples are run periodically with `./infra/cron.sh`.
These scripts report a summary of the average number of edges hit per example, and change since last run
(assuming a summary from the last run is available in the current working directory).

## License
Railcar is distributed under [AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html).
The package `@railcar/support` (code in `packages/support`) is distributed under [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html).
See `REUSE.toml` for details.
