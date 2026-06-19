#!/usr/bin/env bash

# Print a slice of a file by byte offset.
#
# Usage:
#   slice-by-offset.sh <FILE> <START> <END>

FILE="$1"
START="$2"
END="$3"

head -c $END $FILE | tail -c +$START
