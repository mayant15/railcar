#!/usr/bin/env bash
set -euo pipefail

######################################################################################
# Generate lcov coverage report for a single run directory.
# Usage: ./scripts/coverage.sh [--sourcemaps] <run-dir> [coverage-output-dir]
#
# <run-dir>            A directory containing fuzzer-config.json and replay data.
# [coverage-output-dir] Where to write the report (default: ./coverage/<run-name>).
#
# Generated with Amp
# https://ampcode.com/threads/T-019dac86-856c-71af-957e-a98ca99e8289
######################################################################################

SOURCEMAPS=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sourcemaps) SOURCEMAPS=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

RUN_DIR="${1:?Usage: $0 [--sourcemaps] <run-dir> [coverage-output-dir]}"
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

# Extract the package directory from an entrypoint path.
# e.g. .../node_modules/@angular/compiler/fesm2022/compiler.mjs -> node_modules/@angular/compiler
# e.g. .../node_modules/lodash/lodash.js -> node_modules/lodash
get_pkg_dir() {
  local ep="$1"
  local rel="${ep#*node_modules/}"
  if [[ "$rel" == @* ]]; then
    echo "node_modules/${rel%%/*}/$(echo "${rel#*/}" | cut -d/ -f1)"
  else
    echo "node_modules/${rel%%/*}"
  fi
}

# Extract project name from run directory name (prefix before _sequence_).
get_project_name() {
  local name="$1"
  echo "${name%%_sequence_*}"
}

# Per-project c8 include/exclude overrides.
# Sets PROJECT_INCLUDE and PROJECT_EXCLUDE (space-separated globs).
get_project_c8_args() {
  local project="$1"
  PROJECT_INCLUDE=""
  PROJECT_EXCLUDE=""
  case "$project" in
    fast-xml-parser)
      PROJECT_INCLUDE="node_modules/fast-xml-parser/src/**"
      ;;
  esac
}

config="$RUN_DIR/fuzzer-config.json"
entrypoint="$(jq -r '.config.entrypoint' "$config")"
schema_file="$(jq -r '.config.schema_file' "$config")"
config_file="$(jq -r '.config.config_file' "$config")"
seed="$(jq -r '.config.seed' "$config")"

pkg_dir="$(get_pkg_dir "$entrypoint")"
project="$(get_project_name "$run_name")"
get_project_c8_args "$project"

c8_args=()
for pat in ${PROJECT_INCLUDE:-$pkg_dir/**}; do
  c8_args+=(--include "$pat")
done
for pat in $PROJECT_EXCLUDE; do
  c8_args+=(--exclude "$pat")
done

run_coverage_dir="${2:-$(pwd)/coverage/$run_name}"
mkdir -p "$run_coverage_dir"

echo "=== $run_name ==="
echo "include/exclude: ${c8_args[*]}"

# Hide sourcemaps unless --sourcemaps is passed, to prevent c8 from resolving
# webpack:// URLs in .map files to phantom paths that don't exist on disk.
# Handles both external .map files and sourceMappingURL comments (external refs
# and inline data: URIs).
hidden_maps=()
stripped_files=()
if [[ "$SOURCEMAPS" == false ]]; then
  while IFS= read -r -d '' mapfile; do
    mv "$mapfile" "$mapfile.hidden"
    hidden_maps+=("$mapfile")
  done < <(find "$pkg_dir" -name '*.map' -print0 2>/dev/null)

  while IFS= read -r -d '' jsfile; do
    if grep -q 'sourceMappingURL=' "$jsfile"; then
      cp "$jsfile" "$jsfile.bak"
      sed -i '/sourceMappingURL=/d' "$jsfile"
      stripped_files+=("$jsfile")
    fi
  done < <(find "$pkg_dir" -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \) -print0 2>/dev/null)
fi

restore_maps() {
  for mapfile in "${hidden_maps[@]}"; do
    mv "$mapfile.hidden" "$mapfile"
  done
  for jsfile in "${stripped_files[@]}"; do
    mv "$jsfile.bak" "$jsfile"
  done
}
trap restore_maps EXIT

# --all ensures every file matching --include appears in the report,
# even if never loaded, giving a constant denominator across runs.
npx c8 \
  --all \
  --clean \
  --exclude-node-modules=false \
  "${c8_args[@]}" \
  --temp-directory "$run_coverage_dir/.c8" \
  --reports-dir "$run_coverage_dir" \
  --reporter lcov \
  cargo run --bin railcar --release -- \
  --replay \
  --outdir "$RUN_DIR" \
  --seed "$seed" \
  --schema "$schema_file" \
  --config "$config_file" \
  "$entrypoint" \
|| echo "Warning: c8/replay failed for $run_name" >&2

restore_maps
trap - EXIT

echo "Coverage for $run_name -> $run_coverage_dir"
