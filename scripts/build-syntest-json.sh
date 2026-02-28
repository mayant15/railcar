#!/usr/bin/env bash
set -euo pipefail

# Grok created this file, edited and checked by Int2k.
# Run this script at root repository

if [ ! -d "examples/" ]; then
    echo "Please run this script at root repo"
    exit 1
fi

echo
echo "Running from: $(pwd)"
echo

LIST=false
CLEAR=false

if [[ $# -gt 0 ]]; then
    while [[ $# -gt 0 ]]; do
        case $1 in
            --list)
                LIST=true
                shift
                ;;
            --clear)
                CLEAR=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [OPTIONS]"
                echo
                echo "Options:"
                echo "  --list      List all syntest.json files under examples/"
                echo "  --clear     Delete all syntest.json files under examples/"
                echo "  --build     Bob the builder"
                echo "  (no flag)   force to input a flag"
                exit 0
                ;;
            --build|-b)
                echo "build mode"
                shift
                ;;
            *)
                echo "Unknown option: $1" >&2
                echo "Use --help for usage" >&2
                exit 1
                ;;
        esac
    done
else
    echo "Give an option, Use --help for usage" >&2
    exit 1
fi

list() {
    echo "Found syntest.json files:"
    echo "──────────────────────────────────────────────"
    found=false
    while IFS= read -r -d '' file; do
        echo "  • ${file#./}"
        found=true
    done < <(find examples -type f -name "syntest.json" -print0 2>/dev/null)

    if ! $found; then
        echo "  (none found)"
    fi
    echo
}

# ────────────────────────────────────────────────────────────────
#  Handle --list
# ────────────────────────────────────────────────────────────────
if $LIST; then
    list
    exit 0
fi

# ────────────────────────────────────────────────────────────────
#  Handle --clear
# ────────────────────────────────────────────────────────────────
if $CLEAR; then
    echo "This will DELETE all syntest.json files under examples/"
    echo

    # Count how many would be affected (for user awareness)
    count=$(find examples -type f -name "syntest.json" 2>/dev/null | wc -l)
    if (( count == 0 )); then
        echo "No syntest.json files found. Nothing to delete."
        exit 0
    fi

    echo "Found $count file(s)."
    list
    echo
    read -p "Are you sure you want to continue? (y/N) " -n 1 -r
    echo   

    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi

    echo "Removing files..."
    find examples -type f -name "syntest.json" -delete -print | sed 's/^/  deleted: /'

    echo
    echo "Done."
    exit 0
fi

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
    ["angular"]="node_modules/@angular/compiler/fesm2022/compiler.mjs"
    ["js-yaml"]="node_modules/js-yaml/dist/js-yaml.js"
)

# ────────────────────────────────────────────────────────────────
#  Projects with custom build steps / different entrypoints
# ────────────────────────────────────────────────────────────────
declare -A custom_entrypoints=(
    ["sharp"]='
        entry="node_modules/sharp/lib/index.js"
        esbuild_args="--bundle --format=cjs --platform=node --outfile=$TMP_DIR/sharp.bundled.js"
        bundle_file="$TMP_DIR/sharp.bundled.js"
    '
    ["jimp"]='
        entry="node_modules/jimp/dist/commonjs/index.js"
        esbuild_args="--bundle --platform=node --outfile=$TMP_DIR/jimp-common.bundled.js"
        bundle_file="$TMP_DIR/jimp-common.bundled.js"
    '
    ["lit"]='
        entry="node_modules/lit/index.js"
        esbuild_args="--bundle --format=esm --platform=node --outfile=$TMP_DIR/lit.bundled.js"
        bundle_file="$TMP_DIR/lit.bundled.js"
    '
    ["lodash"]='
        entry="node_modules/lodash/index.js"
        esbuild_args="--bundle --format=esm --platform=node --outfile=$TMP_DIR/lodash.bundled.js"
        bundle_file="$TMP_DIR/lodash.bundled.js"
    '
    ["turf"]='
        entry="node_modules/@turf/turf/dist/esm/index.js"
        esbuild_args="--bundle --format=esm --platform=node --outfile=$TMP_DIR/turf.bundled.js"
        bundle_file="$TMP_DIR/turf.bundled.js"
    '
    ["xml2js"]='
        entry="node_modules/xml2js/lib/xml2js.js"
        esbuild_args="--bundle --format=cjs --platform=node --outfile=$TMP_DIR/xml2js.bundled.js"
        bundle_file="$TMP_DIR/xml2js.bundled.js"
    '
    ["xmldom"]='
        entry="node_modules/@xmldom/xmldom/lib/index.js"
        esbuild_args="--bundle --format=esm --platform=node --outfile=$TMP_DIR/xmldom.bundled.js"
        bundle_file="$TMP_DIR/xmldom.bundled.js"
    '
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

    if [[ -f "$output" ]] then
        info "schema for $name existed, skipping ..."
        return
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

echo "Building custom custom_entrypoints into $TMP_DIR/"
echo "───────────────────────────────────────"

for name in "${!custom_entrypoints[@]}"; do
    eval "${custom_entrypoints[$name]}"  

    echo "Project: $name"
    echo "  Entrypoint:   $entry"
    echo "  Bundle file:  $bundle_file"

    # Build only if needed
    echo "  Bundling..."
    bunx esbuild "$entry" $esbuild_args
done

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
    eval "${custom_entrypoints[$name]}"

    if [[ -z "${bundle_file:-}" ]]; then
        echo "Error: bundle_file not found for $name" >&2
        continue
    fi

    build_schema "$name" "$bundle_file"
done

# 3. fast-xml-parser && jpeg-js
echo "→ fast-xml-parser"

FXP_SRC="$PWD/node_modules/fast-xml-parser/"
FXP_TMP="$TMP_DIR/fast-xml-parser/"
FXP_OUT="$TMP_DIR/fxp.bundled.js"

if [[ ! -d "$FXP_SRC" ]]; then
    echo "Error: node_modules/fast-xml-parser/src/ not found" >&2
    echo "install all node modules dependencies first." >&2
    exit 1
fi
rm -rf "$FXP_TMP"
mkdir -p "$FXP_TMP"
cp -r "$FXP_SRC/." "$FXP_TMP/"
(
    cd "$FXP_TMP"
    bunx esbuild src/fxp.js --bundle --platform=node --outfile="$FXP_OUT.tmp"
    mv "$FXP_OUT.tmp" "$FXP_OUT"
)
echo "   → $FXP_OUT"
echo


echo "→ jpeg-js"
JPEG_SRC="$PWD/node_modules/jpeg-js"
JPEG_TMP="$TMP_DIR/jpeg-js"
JPEG_OUT="$TMP_DIR/jpeg-js.bundled.js"
if [[ ! -d "$JPEG_SRC" ]]; then
    echo "Error: node_modules/jpeg-js not found" >&2
    echo "install all node modules dependencies first." >&2
    exit 1
fi
rm -rf "$JPEG_TMP"
mkdir -p "$JPEG_TMP"
cp -r "$JPEG_SRC/." "$JPEG_TMP/"

(
    cd "$JPEG_TMP"
    bunx esbuild index.js --bundle --outfile="$JPEG_OUT.tmp"
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
