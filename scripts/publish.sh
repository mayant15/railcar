#!/usr/bin/env bash

set -euo pipefail

################################################################################
# Update version numbers

VERSION="$1"

cargo workspace-version update "$VERSION"
fd package.json | bun ./scripts/bump-version.ts "$VERSION"

################################################################################
# Sanity checks

mise fix
bun audit
cargo deny check
reuse lint

# Check if everything still builds
bun i
mise build

################################################################################
# Publish packages

# Simple JS packages

cd packages/inference
bun publish --access public

cd ../support
bun publish --access public

cd ../worker
bun publish --access public

# Prepare and publish worker-sys

cd ../worker-sys
cp worker-sys.linux-x64-gnu.node ./npm/linux-x64-gnu
cargo about generate --locked --fail -o npm/linux-x64-gnu/third-party.html ../../about.hbs

cd ./npm/linux-x64-gnu
bun publish --access public

cd ../..
bun publish --access public

# Prepare and publish CLI

cd ../cli
cp -v ../../target/release/railcar ./npm/linux-x64-gnu/
cargo about generate --locked --fail -o npm/linux-x64-gnu/third-party.html ../../about.hbs

cd ./npm/linux-x64-gnu
bun publish --access public

cd ../../
bun publish --access public
