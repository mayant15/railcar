#!/usr/bin/env bash

set -euo pipefail

SEED="$RANDOM"

fuzz() {
  SCHEMA="$1"

  cargo run --bin railcar --release -- \
    --iterations 2 \
    --outdir ${OUTDIR} \
    --schema examples/example/${SCHEMA}.json \
    --config examples/example/railcar.config.js \
    --seed ${SEED} \
    examples/example/index.js
}

coverage() {
  SCHEMA="$1"
  COVERAGE_DIR="railcar-out/example_sequence_${SCHEMA}_index_0/.c8"

  NODE_V8_COVERAGE="${COVERAGE_DIR}" cargo run --bin railcar --release -- \
    --replay \
    --outdir ${OUTDIR} \
    --schema examples/example/${SCHEMA}.json \
    --config examples/example/railcar.config.js \
    --seed ${SEED} \
    examples/example/index.js
}

run() {
  SCHEMA="$1"
  OUTDIR="railcar-out/example_sequence_${SCHEMA}_index_0_0"

  mkdir -p "$OUTDIR"
  fuzz ${SCHEMA} || true
  coverage ${SCHEMA} || true
}

node ./scripts/make-metrics-db.ts

rm -rf railcar-out
run random
run typescript

node ./scripts/coverage-to-sqlite.ts metrics.db ./railcar-out

sqlite3 metrics.db -header -column
