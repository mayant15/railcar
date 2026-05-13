### generated with love by Claude AI

#!/usr/bin/env bash
set -euo pipefail

COVERAGE_DIR="${1:-coverage}"

for lcov_file in "$COVERAGE_DIR"/*/lcov.info; do
  run_dir="$(dirname "$lcov_file")"
  run_name="$(basename "$run_dir")"
  html_dir="$run_dir/html"

  if [[ -d "$html_dir" ]]; then
    echo "Skipping $run_name (html already exists)"
    continue
  fi

  echo "Generating HTML for $run_name ..."
  bun ./scripts/lcov-to-html.ts "$lcov_file" --out "$html_dir" \
    || echo "Warning: failed for $run_name" >&2
done

echo "Done."