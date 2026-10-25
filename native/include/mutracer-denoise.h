#ifndef MUTRACER_DENOISE_H
#define MUTRACER_DENOISE_H
#include <stdint.h>
#include <stddef.h>
#include "mutracer-status.h"
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental optional native OIDN API; see native/README.md#platforms for
 * supported platforms.
 * Returns MT_OK or an mt_status; error is optional caller-owned UTF-8 storage,
 * NUL terminated when capacity>0. Its storage must not overlap other arguments.
 * All other pointers must be aligned, valid for the call and span the specified
 * count; keep input storage unchanged until run returns. A validation/SDK failure
 * leaves image, handle and backend outputs unchanged.
 *
 * OIDN 2.5.1 and matching CPU/Metal/CUDA/HIP device modules must be supplied separately.
 * library is a NUL-terminated UTF-8 shared-library path; NULL uses
 * MUTRACER_OIDN_LIBRARY, then the bundled library relative to the executable
 * (../Frameworks/libOpenImageDenoise.2.dylib on macOS, OpenImageDenoise.dll on
 * Windows, libOpenImageDenoise.so.2 on Linux).
 * backend (mt_denoise_backend): MT_DENOISE_AUTO tries Metal, CUDA, HIP, then CPU;
 * MT_DENOISE_CPU, MT_DENOISE_METAL, MT_DENOISE_CUDA and MT_DENOISE_HIP never fall
 * back. The backend query returns the selected explicit backend.
 *
 * Calls may come from any thread. Overlapping denoiser operations return
 * MT_ERROR_BUSY and can be retried. IDs are not reused; stale handles return
 * MT_ERROR_INVALID_HANDLE. Invalid sizes, pointers, images or backend values
 * return MT_ERROR_INVALID_ARGUMENT; a missing library or unavailable backend
 * returns MT_ERROR_UNAVAILABLE from create. Device memory
 * limits the number of live handles.
 * Denoising is independent of render contexts and does not modify
 * render accumulation. Calls block: run on an application worker if needed.
 * Destroy releases its resources; caller supplies/owns runtime files.
 */
typedef uint64_t mt_denoiser;
int32_t mt_denoiser_create(const char *library, uint32_t backend, mt_denoiser *output,
  char *error, size_t capacity);
int32_t mt_denoiser_backend(mt_denoiser handle, uint32_t *output, char *error, size_t capacity);
/* color,normal,albedo: finite linear RGBA f32, matching dimensions/row order;
 * output: same layout. count is floats per image, exactly width*height*4.
 * Dimensions must be nonzero and total pixels<=16777216. All three inputs are
 * required; normal/albedo are treated as noisy accumulated guides.
 * Filters HDR RGB, preserves color alpha exactly, and never modifies inputs
 * unless they alias output. Output may alias any input; no partial result is
 * written on failure. Temporary image copies add memory proportional to pixels;
 * changing dimensions allocates new image storage. No denoising parity guarantee
 * with the browser filter. A backend error may require destroy/create to recover.
 */
int32_t mt_denoiser_run(mt_denoiser handle, uint32_t width, uint32_t height,
  const float *color, const float *normal, const float *albedo, float *output,
  size_t count, char *error, size_t capacity);
int32_t mt_denoiser_destroy(mt_denoiser handle, char *error, size_t capacity);
#ifdef __cplusplus
}
#endif
#endif
