#!/usr/bin/env bash
set -euo pipefail

######################################################################################
# Collect raw V8 block coverage for a single run directory using Node's built-in
# NODE_V8_COVERAGE feature. No c8, no reporters — the resulting JSON dumps are
# consumed directly by `scripts/coverage-to-sqlite.ts`.
#
# Usage: ./scripts/coverage-v8.sh <run-dir> [coverage-output-dir]
#
# <run-dir>             A directory containing fuzzer-config.json and replay data.
# [coverage-output-dir] Where to write the V8 dumps (default: ./coverage/<run-name>).
#                       Dumps land in <coverage-output-dir>/.c8/coverage-*.json so
#                       the layout matches what scripts/coverage-to-sqlite.ts
#                       already expects.
#
# Generated with Amp
# https://ampcode.com/threads/T-019e381c-07b2-73d2-bd68-28efe38ead9e
######################################################################################

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Rebase a path from the supercomputer onto the local repo root.
# Strips everything up to and including the first occurrence of "railcar/"
# and prepends the local REPO_ROOT.
# e.g. /lustre07/scratch/zwb/another_railcar/railcar/examples/angular/railcar.config.js
#   -> $REPO_ROOT/examples/angular/railcar.config.js
rebase_path() {
  local remote_path="$1"
  local relative="${remote_path#*/railcar/}"
  if [[ "$relative" == "$remote_path" ]]; then
    echo "$remote_path"
  else
    echo "$REPO_ROOT/$relative"
  fi
}

RUN_DIR="${1:?Usage: $0 <run-dir> [coverage-output-dir]}"
RUN_DIR="${RUN_DIR%/}"

if [[ ! -d "$RUN_DIR" ]]; then
  echo "Error: '$RUN_DIR' is not a directory" >&2
  exit 1
fi

if [[ ! -f "$RUN_DIR/fuzzer-config.json" ]]; then
  echo "Error: '$RUN_DIR' does not contain fuzzer-config.json" >&2
  exit 1
fi

run_name="$(basename "$RUN_DIR")"

config="$RUN_DIR/fuzzer-config.json"
entrypoint="$(rebase_path "$(jq -r '.config.entrypoint' "$config")")"
schema_file="$(rebase_path "$(jq -r '.config.schema_file' "$config")")"
config_file="$(rebase_path "$(jq -r '.config.config_file' "$config")")"
seed="$(jq -r '.config.seed' "$config")"

run_coverage_dir="${2:-$(pwd)/coverage/$run_name}"
v8_dir="$run_coverage_dir/.c8"
mkdir -p "$v8_dir"
# Start clean so dumps from prior runs don't contaminate this one.
rm -f "$v8_dir"/coverage-*.json

echo "=== $run_name ==="
echo "V8 coverage dir: $v8_dir"

# NODE_V8_COVERAGE causes every Node process spawned by the replay (including
# the worker subprocesses railcar starts) to dump raw block coverage JSON into
# the given directory on exit. The format matches what
# scripts/coverage-to-sqlite.ts (via branch-extract.ts) parses.
NODE_V8_COVERAGE="$v8_dir" \
  cargo run --bin railcar --release -- \
  --replay \
  --outdir "$RUN_DIR" \
  --seed "$seed" \
  --schema "$schema_file" \
  --config "$config_file" \
  "$entrypoint" \
|| echo "Warning: replay failed for $run_name" >&2

echo "V8 coverage for $run_name -> $v8_dir"
