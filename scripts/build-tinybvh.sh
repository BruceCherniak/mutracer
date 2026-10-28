#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$PROJECT_DIR/src/tinybvh"
INCLUDE_DIR="$(node "$SCRIPT_DIR/fetch-tinybvh.mjs")"

em++ "$SOURCE_DIR/tinybvh_wrapper.cpp" \
  -I"$INCLUDE_DIR" \
  -O3 \
  -std=c++20 \
  --no-entry \
  -sSTANDALONE_WASM \
  -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=1MB \
  -sMALLOC=emmalloc \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_tinybvh_build,_tinybvh_result_data,_tinybvh_result_size,_tinybvh_result_max_depth,_tinybvh_result_layout,_tinybvh_result_destroy \
  -o "$SOURCE_DIR/tinybvh.wasm"
chmod 644 "$SOURCE_DIR/tinybvh.wasm"

echo "Built $SOURCE_DIR/tinybvh.wasm from $INCLUDE_DIR"
