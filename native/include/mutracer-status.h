#ifndef MUTRACER_STATUS_H
#define MUTRACER_STATUS_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Status codes and enumerated values shared by the MuTracer native C API.
 *
 * Every int32_t-returning function returns MT_OK (0) on success and a nonzero
 * mt_status on failure. Check `status != MT_OK` for failure; later ABI versions
 * may add codes, so treat an unknown nonzero value like MT_ERROR. The optional
 * error message still describes the failure and is not a stable contract.
 */
typedef int32_t mt_status;
enum {
  MT_OK = 0,
  /* Failure without a more specific code below. */
  MT_ERROR = 1,
  /* A pointer, size, struct_size, enumerated value or descriptor
   * was rejected by validation or limits. Nothing changed. */
  MT_ERROR_INVALID_ARGUMENT = 2,
  /* Unknown, destroyed or expired context, job or denoiser handle. */
  MT_ERROR_INVALID_HANDLE = 3,
  /* Another call on the same registry is running; retry later. */
  MT_ERROR_BUSY = 4,
  /* The call is not allowed now: no committed scene, an active job, a failed
   * scene, a commit still preparing, no completed samples, or a log
   * callback calling back into the library. Nothing changed. */
  MT_ERROR_INVALID_STATE = 5,
  /* Reserved: returned by the incremental update calls removed in ABI 3.
   * Commits choose incremental or full preparation themselves. */
  MT_ERROR_FULL_COMMIT_REQUIRED = 6,
  /* mt_context_cancel_commit stopped this commit; the previous scene remains. */
  MT_ERROR_CANCELLED = 7,
  /* The destination is too small; the required size was reported. */
  MT_ERROR_BUFFER_TOO_SMALL = 8,
  /* The call failed while executing and marked the context failed. Commit a new
   * scene or destroy the context. */
  MT_ERROR_CONTEXT_FAILED = 9,
  /* A required device, GPU feature or runtime library is unavailable. */
  MT_ERROR_UNAVAILABLE = 10,
  /* mt_context_wait reached its timeout; the GPU work is still running. */
  MT_ERROR_TIMEOUT = 11
};

/* Incremented whenever any native C API declaration or record layout changes
 * incompatibly; the ABI stays experimental until a stable release. Compare it
 * with mt_abi_version() when loading the library dynamically. Scene descriptors
 * carry their own MT_VERSION_SCENE. */
#define MT_ABI_VERSION 6u
uint32_t mt_abi_version(void);

/* Every struct passed to or filled by the library starts with uint32_t
 * struct_size. Set it to sizeof(struct) before the call; an unsupported size
 * returns MT_ERROR_INVALID_ARGUMENT without accessing the remaining fields.
 * Use the current record definitions; older sizes are not accepted. Initializer
 * functions fill the current record and its struct_size. Scene descriptors carry
 * their own version word instead. */

/* Context intersection backend: mt_context_create_with_backend, mt_context_backend. */
typedef enum mt_backend { MT_BACKEND_SOFTWARE = 0, MT_BACKEND_HWRT = 1 } mt_backend;
/* mt_context_read_pixels and mt_render_read_pixels image kind. DENOISED is
 * for renders only (mutracer-engine.h). */
typedef enum mt_image_kind {
  MT_IMAGE_HDR = 0, MT_IMAGE_NORMAL = 1, MT_IMAGE_ALBEDO = 2, MT_IMAGE_DENOISED = 3
} mt_image_kind;
/* mt_context_snapshot.state. */
typedef enum mt_context_state {
  MT_CONTEXT_EMPTY = 0, MT_CONTEXT_COMMITTED = 1, MT_CONTEXT_FAILED = 2,
  MT_CONTEXT_JOB_ACTIVE = 3
} mt_context_state;
/* mt_context_snapshot.last_commit: how the last successful commit was applied.
 * INCREMENTAL kept geometry, acceleration structures and pipelines and updated
 * only what changed; FULL prepared the scene again. */
typedef enum mt_commit_kind {
  MT_COMMIT_NONE = 0,
  MT_COMMIT_FULL = 1,
  MT_COMMIT_INCREMENTAL = 2
} mt_commit_kind;
/* mt_job_snapshot.state. */
typedef enum mt_job_state {
  MT_JOB_QUEUED = 0, MT_JOB_RUNNING = 1, MT_JOB_COMPLETE = 2, MT_JOB_CANCELLED = 3,
  MT_JOB_FAILED = 4, MT_JOB_CANCELLING = 5
} mt_job_state;
/* mt_render_settings.sampling_pattern. */
typedef enum mt_sampling_pattern {
  MT_SAMPLING_SOBOL = 0, MT_SAMPLING_ZSOBOL = 1, MT_SAMPLING_RANDOM = 2
} mt_sampling_pattern;
/* mt_denoiser_create preference and mt_denoiser_backend result. AUTO tries
 * Metal, CUDA, HIP, then CPU; explicit backends never fall back. */
typedef enum mt_denoise_backend {
  MT_DENOISE_AUTO = 0, MT_DENOISE_CPU = 1, MT_DENOISE_METAL = 2,
  MT_DENOISE_CUDA = 3, MT_DENOISE_HIP = 4
} mt_denoise_backend;
#ifdef __cplusplus
}
#endif
#endif
