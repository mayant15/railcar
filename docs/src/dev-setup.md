# Setup

## Building From Source

We use [`mise`](https://mise.jdx.dev/) to manage dependencies and run scripts. Building Railcar
also requires a working C compiler (not managed by `mise`).

In the Railcar directory, run:
```
mise build
```
See `mise.toml` for more scripts.

During development, run Railcar with cargo:
```bash
cargo run --release --bin railcar -- <entrypoint>
```

## Packages

Railcar is a collection of Rust and TypeScript packages.
- `fuzzer/`: Core fuzzer implementation. Rust.
- `cli/`: CLI that invokes fuzzer. Rust.
- `inference/`: Dynamic and static schema inference, including `railcar-infer`. TypeScript.
- `worker/`: Main executor and instrumentation, running in the Node.js child process. TypeScript.
- `worker-sys/`: Native utility functions for `@railcar/worker`. Rust.
- `support/`: Support functions for end users. TypeScript.
- `tools/`: Small CLI utilities useful for development and debugging. Rust.

## Auxiliary Tooling

Running `mise dev` installs a number of auxiliary tools (like `mdbook`) that might be useful for
Railcar developers.
