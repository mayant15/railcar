#!/usr/bin/env bash
set -euo pipefail

# Grok created this file, edited and checked by Int2k.
# Run this script at root repository

if [ ! -d "examples/" ]; then
    echo "Please run this script at root repo"
    exit 1
fi

echo "Running from: $(pwd)"
echo

# ────────────────────────────────────────────────
#  Prepare tmp/ in the RIGHT place (repo root)
# ────────────────────────────────────────────────
TMP_DIR="$(pwd)/tmp"
mkdir -p "$TMP_DIR"

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

RAILCAR_INFER="npx railcar-infer"

# ────────────────────────────────────────────────────────────────
#  Projects that use the DEFAULT entrypoint + config pattern
# ────────────────────────────────────────────────────────────────
declare -A simple_projects=(
    ["typescript"]="node_modules/typescript/lib/typescript.js"
    ["ua-parser-js"]="node_modules/ua-parser-js/src/main/ua-parser.js"
    ["protobufjs"]="node_modules/protobufjs/dist/protobuf.js"
    ["tslib"]="node_modules/tslib/tslib.js"
    ["pako"]="node_modules/pako/dist/pako.js"
    ["redux"]="node_modules/redux/dist/redux.mjs"
    ["angular"]="examples/node_modules/@angular/compiler/fesm2022/compiler.mjs"
    ["js-yaml"]="node_modules/js-yaml/dist/js-yaml.js"
)

# ────────────────────────────────────────────────────────────────
#  Projects with custom build steps / different entrypoints
# ────────────────────────────────────────────────────────────────
declare -A custom_entrypoints=(
    ["sharp"]="node_modules/sharp/lib/index.js"
    ["jimp"]="node_modules/jimp/dist/commonjs/index.js"
    ["lit"]="node_modules/lit/index.js"
    ["lodash"]="node_modules/lodash/index.js"
    ["turf"]="node_modules/@turf/turf/dist/esm/index.js"
    ["xml2js"]="node_modules/xml2js/lib/xml2js.js"
    ["xmldom"]="node_modules/@xmldom/xmldom/lib/index.js"
)

# ────────────────────────────────────────────────────────────────
#  Projects with custom clone & build
# ────────────────────────────────────────────────────────────────
declare -A out_sources=(
    ["fast-xml-parser"]="tmp/fxp.bundled.js"
    ["jpeg-js"]="tmp/jpeg-js.bundled.js"
)

# ────────────────────────────────────────────────────────────────
# Helper functions
# ────────────────────────────────────────────────────────────────

die() {
    echo -e "${RED}Error:${NC} $*" >&2
    exit 1
}

info() {
    echo -e "${YELLOW}→${NC} $*" 
}

success() {
    echo -e "${GREEN}✓${NC} $*" 
}

build_schema() {
    local name="$1"
    local entry="$2"
    local config="examples/${name}/railcar.config.js"
    local output="examples/${name}/syntest.json"

    if [[ ! -f "$config" ]]; then
        die "Config not found: $config"
    fi

    info "Building schema for $name ..."

    if ! $RAILCAR_INFER --syntest \
        --entrypoint "$entry" \
        --config "$config" \
        -o "$output"; then
        echo -e "${RED}Failed:${NC} $name" >&2
        return 1
    fi

    if [[ -f "$output" ]]; then
        success "Created $output"
    else
        die "Output file missing after run: $output"
    fi
}

# ────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────

echo "Building syntest schemas..."
echo "Current directory: $(pwd)"
echo

# 1. Simple projects (default pattern)
for name in "${!simple_projects[@]}"; do
    entry="${simple_projects[$name]}"
    build_schema "$name" "$entry"
done

# 2. Custom entrypoint projects
for name in "${!custom_entrypoints[@]}"; do
    entry="${custom_entrypoints[$name]}"
    build_schema "$name" "$entry"
done

# 3. fast-xml-parser && jpeg-js
# ────────────────────────────────────────────────────────────────
#  fast-xml-parser
# ────────────────────────────────────────────────────────────────
echo "→ fast-xml-parser"

FXP_REPO="$TMP_DIR/fast-xml-parser"
FXP_OUT="$TMP_DIR/fxp.bundled.js"

if [[ ! -d "$FXP_REPO" ]]; then
    echo "  Cloning repository..."
    git clone --depth 1 https://github.com/NaturalIntelligence/fast-xml-parser.git "$FXP_REPO"
fi
(
    cd "$FXP_REPO"
    npm install esbuild
    npx esbuild src/fxp.js --bundle --platform=node --outfile="$FXP_OUT.tmp"
    mv "$FXP_OUT.tmp" "$FXP_OUT"
)
echo "   → $FXP_OUT"
echo

# ────────────────────────────────────────────────────────────────
#  jpeg-js
# ────────────────────────────────────────────────────────────────
echo "→ jpeg-js"
JPEG_SRC="$PWD/node_modules/jpeg-js"
JPEG_TMP="$TMP_DIR/jpeg-js"
JPEG_OUT="$TMP_DIR/jpeg-js.bundled.js"
if [[ ! -d "$JPEG_SRC" ]]; then
    echo "Error: node_modules/jpeg-js not found" >&2
    echo "Run 'npm install' in the repository root first." >&2
    exit 1
fi
rm -rf "$JPEG_TMP"
mkdir -p "$JPEG_TMP"
cp -r "$JPEG_SRC/." "$JPEG_TMP/"

(
    cd "$JPEG_TMP"
    npm install esbuild
    npx esbuild index.js --bundle --outfile="$JPEG_OUT.tmp"
    mv "$JPEG_OUT.tmp" "$JPEG_OUT"
)
echo "   → $JPEG_OUT"
echo

for name in "${!out_sources[@]}"; do
    entry="${out_sources[$name]}"
    build_schema "$name" "$entry"
done

echo
echo "Done."
echo

# Optional: list created files
find examples -name "syntest.json" -type f | sort | sed 's/^/  • /'

exit 0