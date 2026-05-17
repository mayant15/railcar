#!/usr/bin/env bash
set -euo pipefail

######################################################################################
# Collect raw V8 block coverage for all runs in a railcar-results directory using
# scripts/coverage-v8.sh.
#
# Usage: ./scripts/coverage-all.sh [--filter <glob>] <railcar-results-dir>
#
# --filter <glob>   Only process run directories whose basename matches <glob>.
#                   May be passed multiple times to OR several patterns.
#                   Example: --filter 'angular_*' --filter 'jpeg-js_*'
#
# Generated with Amp
# https://ampcode.com/threads/T-019d89a3-73d2-75fc-a9a9-d642c897956a
# https://ampcode.com/threads/T-019dac86-856c-71af-957e-a98ca99e8289
# https://ampcode.com/threads/T-019e381c-07b2-73d2-bd68-28efe38ead9e
######################################################################################

FILTERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter) FILTERS+=("$2"); shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done

RESULTS_DIR="${1:?Usage: $0 [--filter <glob>]... <railcar-results-dir>}"

if [[ ! -d "$RESULTS_DIR" ]]; then
  echo "Error: '$RESULTS_DIR' is not a directory" >&2
  exit 1
fi

COVERAGE_DIR="$(pwd)/coverage"
mkdir -p "$COVERAGE_DIR"

# Decide whether a run name matches any of the supplied --filter globs.
# Returns 0 (match) when no filters are given.
matches_filter() {
  local name="$1"
  if [[ ${#FILTERS[@]} -eq 0 ]]; then
    return 0
  fi
  local pat
  for pat in "${FILTERS[@]}"; do
    # shellcheck disable=SC2053  # we want glob, not literal match
    if [[ "$name" == $pat ]]; then
      return 0
    fi
  done
  return 1
}

# Collect all run directories (skip plain files like .csv, .db).
runs=()
for entry in "$RESULTS_DIR"/*/; do
  name="$(basename "$entry")"
  if [[ -d "$entry" && -f "$entry/fuzzer-config.json" ]] && matches_filter "$name"; then
    runs+=("$entry")
  fi
done

if [[ ${#runs[@]} -eq 0 ]]; then
  echo "No matching runs found in '$RESULTS_DIR'" >&2
  exit 1
fi

echo "Found ${#runs[@]} run(s) in $RESULTS_DIR"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for run_dir in "${runs[@]}"; do
  run_name="$(basename "$run_dir")"
  echo ""
  "$SCRIPT_DIR/coverage-v8.sh" "$run_dir" "$COVERAGE_DIR/$run_name"
done

echo ""
echo "All V8 coverage dumps written to $COVERAGE_DIR"
