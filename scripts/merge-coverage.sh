### generated with love by Claude AI

#!/usr/bin/env bash
set -euo pipefail

COVERAGE_DIR="${1:-coverage}"
MERGED_DIR="$COVERAGE_DIR/merged"
mkdir -p "$MERGED_DIR"

# Get unique (library, schema) combinations
declare -A seen

for lcov_file in "$COVERAGE_DIR"/*/lcov.info; do
  run_name="$(basename "$(dirname "$lcov_file")")"
  library="$(echo "$run_name" | cut -d_ -f1)"
  schema="$(echo "$run_name" | sed 's/.*_sequence_\([^_]*\)_.*/\1/')"
  key="${library}__${schema}"
  seen["$key"]=1
done

for key in "${!seen[@]}"; do
  library="${key%%__*}"
  schema="${key##*__}"
  out="$MERGED_DIR/${library}_${schema}.info"

  if [[ -f "$out" ]]; then
    echo "Skipping $key (already merged)"
    continue
  fi

  # Collect all lcov files for this (library, schema)
  args=()
  for lcov_file in "$COVERAGE_DIR"/${library}_sequence_${schema}_*/lcov.info; do
    [[ -f "$lcov_file" ]] && args+=(-a "$lcov_file")
  done

  if [[ ${#args[@]} -eq 0 ]]; then
    echo "No lcov files found for $key" >&2
    continue
  fi

  echo "Merging ${#args[@]} runs for $key -> $out"
  lcov "${args[@]}" -o "$out"
done

echo "Merged lcov files written to $MERGED_DIR"