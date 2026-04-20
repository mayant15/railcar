#!/usr/bin/env bash
set -euo pipefail

######################################################################################
# Generate lcov and html coverage reports for all runs in a railcar-results directory.
# Usage: ./scripts/coverage-all.sh [--sourcemaps] railcar-results-2026-04-09-1775761570
#
# Generated with Amp
# https://ampcode.com/threads/T-019d89a3-73d2-75fc-a9a9-d642c897956a
# https://ampcode.com/threads/T-019dac86-856c-71af-957e-a98ca99e8289
######################################################################################

SOURCEMAPS_FLAG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sourcemaps) SOURCEMAPS_FLAG=(--sourcemaps); shift ;;
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for run_dir in "${runs[@]}"; do
  run_name="$(basename "$run_dir")"
  echo ""
  "$SCRIPT_DIR/coverage.sh" "${SOURCEMAPS_FLAG[@]+"${SOURCEMAPS_FLAG[@]}"}" "$run_dir" "$COVERAGE_DIR/$run_name"
done

echo ""
echo "All coverage reports written to $COVERAGE_DIR"
