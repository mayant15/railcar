#!/usr/bin/env bash

if [ ! -d "$SRC" ]; then
  echo "[**] Fetching git repository..."
  git clone https://github.com/nodeca/js-yaml "$SRC"

  pushd "$SRC"

  git checkout 0d3ca7a27b03a6c974790a30a89e456007d62976

  echo "[**] Building..."
  npm install
  npm run browserify

  popd
fi

