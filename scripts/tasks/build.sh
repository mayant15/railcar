#!/usr/bin/env bash

# Build the fuzzer and associated tools.

bun i # install dependencies

# always build the workspace in release mode
cargo build --release

cd packages/worker-sys
bun run build
cd ../..

bunx tsc -b # build js parts
bun i # install built binaries to node_modules/.bin
