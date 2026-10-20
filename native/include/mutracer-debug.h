#ifndef MUTRACER_DEBUG_H
#define MUTRACER_DEBUG_H
#include <stddef.h>
#include <stdint.h>
#include "mutracer-scene.h"
#include "mutracer-status.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Debug and validation only. Not part of the supported API: it may change or
 * be removed without an ABI version bump. Use mutracer-context.h in
 * applications.
 *
 * mt_probe_render_scene prepares a mutracer-scene.h descriptor from scratch,
 * renders it once with Sobol, seed 12345 and 6 bounces, and writes files into
 * output_directory (UTF-8 path): render.png (Reinhard/sRGB preview),
 * render.rgba32f, normal.rgba32f and albedo.rgba32f (linear little-endian f32
 * RGBA, bottom row first) and result.json. samples is 1..4096. Every call
 * rebuilds the scene. Bytes are borrowed only until return.
 * Returns MT_OK or an mt_status: MT_ERROR_INVALID_ARGUMENT for a rejected
 * descriptor or argument, MT_ERROR_BUSY while another probe runs.
 */
int32_t mt_probe_render_scene(const uint8_t *input, size_t length,
  const char *output_directory, uint32_t samples, char *error, size_t error_capacity);
#ifdef __cplusplus
}
#endif
#endif
