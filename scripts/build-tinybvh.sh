#!/usr/bin/env bash
set -euo pipefail

TINYBVH_REVISION="0e4584287823252cf83f0e9cd072848bec5f79c5"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$PROJECT_DIR/src/tinybvh"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claypt-tinybvh.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

curl --fail --location --silent --show-error \
  "https://raw.githubusercontent.com/jbikker/tinybvh/$TINYBVH_REVISION/tiny_bvh.h" \
  --output "$TEMP_DIR/tiny_bvh.h"

em++ "$SOURCE_DIR/tinybvh_wrapper.cpp" \
  -I"$TEMP_DIR" \
  -O3 \
  -std=c++20 \
  --no-entry \
  -sSTANDALONE_WASM \
  -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSTACK_SIZE=1MB \
  -sMALLOC=emmalloc \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_tinybvh_build,_tinybvh_refit,_tinybvh_result_take_refit_handle,_tinybvh_refit_handle_destroy,_tinybvh_result_data,_tinybvh_result_size,_tinybvh_result_max_depth,_tinybvh_result_layout,_tinybvh_result_destroy \
  -o "$SOURCE_DIR/tinybvh.wasm"
chmod 644 "$SOURCE_DIR/tinybvh.wasm"

echo "Built $SOURCE_DIR/tinybvh.wasm from tinybvh@$TINYBVH_REVISION"
