#!/usr/bin/env bash

cd $(dirname $(dirname $0))
python ./infra/fuzz.py --timeout 3600
