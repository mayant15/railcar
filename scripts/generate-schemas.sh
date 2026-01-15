#!/usr/bin/env bash

###############################################################################
# Extracts the actual schema used by the fuzzer.
#
# Schemas generated this way are idempotent: using the same schema as input again
# would generate the exact same schema.
#
# Also checks if the three schemas (random, syntest and typescript) have the same
# API surface.
#
# ASSUMES:
# - `reflection.ts` writes the schema to `schema.json`
# - `jq` is available on PATH
# - runs in Railcar's root (needs the `examples/` directory)
#
# EFFECTS:
# - overwrites `random.json`, `syntest.json`, and `typescript.json` schema files
# in `examples/`

PROJECTS=(
  "fast-xml-parser"
  "jpeg-js"
  "pako"
  "jimp"
  "tslib"
  "js-yaml"
  "redux"
  "sharp"
)

RAILCAR="cargo run --bin railcar --release --"

for PROJECT in "${PROJECTS[@]}"
do
  echo "$PROJECT"

  ENTRYPOINT=$(node ./examples/locate-index.js "$PROJECT")
  CONFIG="./examples/$PROJECT/railcar.config.js"

  # Random
  RAND="./examples/$PROJECT/random.json"
  $RAILCAR --config $CONFIG $ENTRYPOINT
  mv -v schema.json $RAND

  # SynTest
  SYNTEST="./examples/$PROJECT/syntest.json"
  $RAILCAR --config $CONFIG --schema $SYNTEST $ENTRYPOINT
  mv -v schema.json $SYNTEST

  # TypeScript
  TYPESCRIPT="./examples/$PROJECT/typescript.json"
  $RAILCAR --config $CONFIG --schema $TYPESCRIPT $ENTRYPOINT
  mv -v schema.json $TYPESCRIPT

  jq 'keys' $RAND > $RAND.keys.json
  jq 'keys' $SYNTEST > $SYNTEST.keys.json
  jq 'keys' $TYPESCRIPT > $TYPESCRIPT.keys.json

  set -e

  diff $RAND.keys.json $SYNTEST.keys.json
  diff $RAND.keys.json $TYPESCRIPT.keys.json

  rm $RAND.keys.json $SYNTEST.keys.json $TYPESCRIPT.keys.json

  set +e
done
