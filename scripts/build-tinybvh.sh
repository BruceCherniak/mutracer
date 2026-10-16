#!/usr/bin/env bash
set -euo pipefail

TINYBVH_REVISION="c9be3103cc9693b456b0a0353927c11cac7d710f"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_DIR="$PROJECT_DIR/src/tinybvh"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mutracer-tinybvh.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT

for header in tiny_bvh.h tiny_bvh_base.h tiny_bvh_arm_float.h \
  tiny_bvh_arm_double.h tiny_bvh_x86_float.h tiny_bvh_x86_double.h; do
  curl --fail --location --silent --show-error \
    "https://raw.githubusercontent.com/jbikker/tinybvh/$TINYBVH_REVISION/$header" \
    --output "$TEMP_DIR/$header"
done

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
  -sEXPORTED_FUNCTIONS=_malloc,_free,_tinybvh_build,_tinybvh_result_data,_tinybvh_result_size,_tinybvh_result_max_depth,_tinybvh_result_layout,_tinybvh_result_destroy \
  -o "$SOURCE_DIR/tinybvh.wasm"
chmod 644 "$SOURCE_DIR/tinybvh.wasm"

echo "Built $SOURCE_DIR/tinybvh.wasm from tinybvh@$TINYBVH_REVISION"
