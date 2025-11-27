# Railcar

Automatic fuzzing for JavaScript libraries without harnesses.

> Railcar is a research prototype. Expect breaking changes before v1.0.

## Installation

We build and test Railcar on Node 24.6.0 on Linux. Railcar does not support Windows but runs on WSL.
```bash
npm install -D @railcar/cli
npx railcar entry-point.js
```
where `entry-point.js` is the root of your JavaScript library. See `npx railcar --help` for more
options.

For more details and other features, see `docs/`.

## License
Railcar is distributed under [AGPL-3.0-or-later](https://spdx.org/licenses/AGPL-3.0-or-later.html).
The package `@railcar/support` (code in `packages/support`) is distributed under [Apache-2.0](https://spdx.org/licenses/Apache-2.0.html).
See `REUSE.toml` for details.
