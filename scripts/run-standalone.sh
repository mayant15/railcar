#!/usr/bin/env bash

set -euo pipefail

rm -rf coverage-standalone metrics.cov.db
mkdir coverage-standalone

PROJECTS=(
  fast-xml-parser
  jimp
  js-yaml
  protobufjs
  redux
  sharp
  tslib
  typescript
  xml2js
  xmldom

  # slow...
  # angular
  # jpeg-js
  # lit
  # lodash
  # pako
  # turf
)

run_project_schema() {
  PROJECT="$1"
  SCHEMA="$2"
  COVDIR="coverage-standalone/$PROJECT""_single_"$SCHEMA"_index_0/.c8"
  NODE_V8_COVERAGE=$COVDIR node ./scripts/standalone.ts $PROJECT $SCHEMA
}


for PROJECT in "${PROJECTS[@]}"; do
  echo "testing $PROJECT"

  echo "  random"
  run_project_schema $PROJECT random &> /dev/null
  echo "  syntest"
  run_project_schema $PROJECT syntest &> /dev/null
  echo "  typescript"
  run_project_schema $PROJECT typescript &> /dev/null
done

cp metrics.db metrics.cov.db
node ./scripts/coverage-to-sqlite.ts metrics.cov.db coverage-standalone &> /dev/null

echo ""

echo "project,total,random,syntest,typescript"
for PROJECT in "${PROJECTS[@]}"; do
  BRANCHES="SELECT id FROM branches WHERE file LIKE '%$PROJECT%'"
  sqlite3 -csv metrics.cov.db "
    SELECT
      '$PROJECT',
      (SELECT count(*) FROM branches WHERE file LIKE '%$PROJECT%'),
      (SELECT count(*) FROM coverage WHERE schema = 'random' AND hitcount > 0 AND branch_id IN ($BRANCHES)),
      (SELECT count(*) FROM coverage WHERE schema = 'syntest' AND hitcount > 0 AND branch_id IN ($BRANCHES)),
      (SELECT count(*) FROM coverage WHERE schema = 'typescript' AND hitcount > 0 AND branch_id IN ($BRANCHES));
  "
done
