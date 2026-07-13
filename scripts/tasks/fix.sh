#!/usr/bin/env bash

# Lint and fix what we can

bunx biome format --write .
bunx biome lint --error-on-warnings --write .

cargo fmt
cargo clippy
