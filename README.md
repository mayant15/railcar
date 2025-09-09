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
where `entry-point.js` is the root of your JavaScript library.

Once you have a corpus directory, replay for coverage with:
```
npx nyc --reporter lcov --report-dir <coverage-dir> railcar -- replay --corpus <corpus-dir>
```

See `npx railcar --help` for more details.

## Developing

We use [`mise`](https://mise.jdx.dev/) to manage dependencies and run scripts.
Building Railcar also requires a working C compiler.
Some scripts require [`fd`](https://github.com/sharkdp/fd) and [`rg`](https://github.com/BurntSushi/ripgrep) on PATH.

In the Railcar directory, run:
```
mise setup
mise build
```

## License
Railcar is distributed under [AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html).
The package `@railcar/support` (code in `packages/support`) is distributed under [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html).
See `REUSE.toml` for details.
