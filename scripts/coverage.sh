#!/usr/bin/env bash
set -euo pipefail

######################################################################################
# Generate lcov and html coverage reports for all runs in a railcar-results directory.
# Usage: ./scripts/coverage.sh [--sourcemaps] railcar-results-2026-04-09-1775761570
#
# Generated with Amp
# https://ampcode.com/threads/T-019d89a3-73d2-75fc-a9a9-d642c897956a
######################################################################################

SOURCEMAPS=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sourcemaps) SOURCEMAPS=true; shift ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

RESULTS_DIR="${1:?Usage: $0 [--sourcemaps] <railcar-results-dir>}"

if [[ ! -d "$RESULTS_DIR" ]]; then
  echo "Error: '$RESULTS_DIR' is not a directory" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COVERAGE_DIR="$(pwd)/coverage"
mkdir -p "$COVERAGE_DIR"

# Collect all run directories (skip plain files like .csv, .db)
runs=()
for entry in "$RESULTS_DIR"/*/; do
  [[ -d "$entry" && -f "$entry/fuzzer-config.json" ]] && runs+=("$entry")
done

if [[ ${#runs[@]} -eq 0 ]]; then
  echo "No runs found in '$RESULTS_DIR'" >&2
  exit 1
fi

echo "Found ${#runs[@]} run(s) in $RESULTS_DIR"

# Extract the package directory from an entrypoint path.
# e.g. .../node_modules/@angular/compiler/fesm2022/compiler.mjs -> node_modules/@angular/compiler
# e.g. .../node_modules/lodash/lodash.js -> node_modules/lodash
get_pkg_dir() {
  local ep="$1"
  # Strip everything up to and including the first "node_modules/"
  local rel="${ep#*node_modules/}"
  if [[ "$rel" == @* ]]; then
    # Scoped package: @scope/name
    echo "node_modules/${rel%%/*}/$(echo "${rel#*/}" | cut -d/ -f1)"
  else
    echo "node_modules/${rel%%/*}"
  fi
}

# Extract project name from run directory name (prefix before _sequence_).
get_project_name() {
  local run_name="$1"
  echo "${run_name%%_sequence_*}"
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

for run_dir in "${runs[@]}"; do
  run_name="$(basename "$run_dir")"
  echo ""
  echo "=== $run_name ==="

  config="$run_dir/fuzzer-config.json"
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

  run_coverage_dir="$COVERAGE_DIR/$run_name"
  mkdir -p "$run_coverage_dir"

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
    --reporter lcov --reporter html \
    cargo run --bin railcar --release -- \
    --replay \
    --outdir "$run_dir" \
    --seed "$seed" \
    --schema "$schema_file" \
    --config "$config_file" \
    "$entrypoint" \
  || echo "Warning: c8/replay failed for $run_name" >&2

  restore_maps
  trap - EXIT

  echo "Coverage for $run_name -> $run_coverage_dir"
done

echo ""
echo "All coverage reports written to $COVERAGE_DIR"
