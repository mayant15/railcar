#!/usr/bin/env bash

if [ ! -d "$SRC" ]; then
  echo "[*] Fetching git repository..."
  git clone https://github.com/NaturalIntelligence/fast-xml-parser "$SRC"

  pushd "$SRC"

  git checkout 42712223112bcdf3b198b4573ca86489cd4d2c5c

  echo "[*] Building..."
  npm install
  npm run bundle

  popd
fi
