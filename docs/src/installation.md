# Installation

> We build and test Railcar on Node 24.6.0 on Linux. Railcar does not support Windows but runs on WSL.

Install Railcar with:
```bash
npm install -D @railcar/cli
npm install -D @railcar/support # optional
```

## Building From Source

We use [`mise`](https://mise.jdx.dev/) to manage dependencies and run scripts. Building Railcar
also requires a working C compiler (not managed by `mise`).

After following the steps to [install](https://mise.jdx.dev/getting-started.html#installing-mise-cli) and [activate](https://mise.jdx.dev/getting-started.html#activate-mise) `mise`,
build Railcar with:
```
mise build
```
See `mise.toml` for more scripts.

During development, run Railcar with cargo:
```bash
cargo run --release --bin railcar -- <entrypoint>
```

### Auxiliary Tooling

Running `mise dev` installs a number of auxiliary tools (like `mdbook`) that might be useful for
Railcar developers.
