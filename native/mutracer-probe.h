#ifndef MUTRACER_NATIVE_PROBE_H
#define MUTRACER_NATIVE_PROBE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental blocking capture renderer, NOT the final MuTracer C API.
 * Call sequentially on one owner thread. All paths are UTF-8, NUL-terminated.
 * samples: 0 selects the capture default; otherwise 1..4096.
 * Returns 0 on success, 1 on failure. error may be NULL; otherwise it must be
 * writable for error_capacity bytes, and receives a truncated NUL-terminated
 * diagnostic. Input/output storage belongs to the caller. A fatal scriptc
 * runtime trap is not recoverable through this experimental entry.
 */
int32_t mt_probe_render(const char *scene_directory, const char *output_directory,
                       uint32_t samples, char *error, size_t error_capacity);
/* All fields must be initialized. sizeof(struct) is currently 52 bytes.
 * flags: bit 0 applies world-space camera translation (orientation/lens fixed);
 * bit 1 patches one existing material's linear RGB base color and roughness.
 * Prepared replay uses software traversal; use raw contexts for HWRT.
 * Material values must be in 0..1. Patches cannot enable new shader variants.
 * samples=0 uses capture default; seed/bounces always apply (defaults 12345/6).
 * Options affect only this render; the capture files are never modified.
 */
typedef struct mt_probe_options {
  uint32_t struct_size, flags, samples, seed;
  float bounces, camera_offset[3];
  uint32_t material_index;
  float base_color[3], roughness;
} mt_probe_options;
int32_t mt_probe_render_with_options(const char *scene_directory, const char *output_directory,
                                    const mt_probe_options *options, char *error, size_t error_capacity);
#ifdef __cplusplus
}
#endif
#endif
