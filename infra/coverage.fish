#!/usr/bin/fish

###############################################################################
# An example of how to use c8 generate coverage reports from an existing corpus

rm -rf .c8_output/ coverage/

npx c8 \
  --clean \
  --exclude-node-modules=false \
  --include 'node_modules/@angular/compiler/**' \
  --temp-directory .c8 \
  --reporter text \
  cargo run --bin railcar --release -- \
  --replay \
  --outdir railcar-results-2026-04-09-1775781091/angular_sequence_random_compiler_0 \
  --seed 6817 \
  --schema examples/angular/random.json \
  --config examples/angular/railcar.config.js \
  (node ./examples/locate-index.js "@angular/compiler")
