#!/usr/bin/env bash

if [ ! -d "$SRC" ]; then
  echo "[*] Fetching git repository..."
  git clone https://github.com/NaturalIntelligence/fast-xml-parser "$SRC"

  pushd "$SRC"

  git checkout 7e74b4ff519b230ee1c0059ce1d5c7efd359f2c7

  echo "[*] Building..."

  # TODO: there's a post-install script somewhere in there that requires interactive
  # confirmation. Doing it twice works though.
  npm install
  npm install

  npm run bundle

  popd
fi
