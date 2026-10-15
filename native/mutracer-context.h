#ifndef MUTRACER_CONTEXT_H
#define MUTRACER_CONTEXT_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Experimental persistent C API, macOS arm64. Return 0 on success, 1 on error;
 * If error is non-NULL and capacity > 0, it receives a truncated
 * NUL-terminated UTF-8 message (complete characters only).
 * All pointers must remain valid for the call; input is copied, no pointers are
 * retained. Pixel storage belongs to the caller. This ABI is not stable yet.
 *
 * All contexts and probe calls must use the first creating owner thread until
 * process exit (including after destroying the last context). Calls are
 * serialized; render/read/reset/commit can block. Jobs use polling below.
 * At most eight contexts. Context handles are
 * unique until process exit; destroyed/unknown handles return errors.
 * Contexts retain GPU resources between renders; commit replaces the complete
 * scene. A failed commit preserves the previous scene,
 * samples and outputs. Successful commit resets samples to zero, including a
 * camera/material edit submitted through the same raw descriptor. Commit can
 * temporarily hold both scenes' resources. Descriptors are in mutracer-scene.h.
 *
 * render adds samples to the current accumulation, total 1..4096. Seed 12345,
 * bounces 6 and Sobol configuration match the raw probe. reset clears accumulation
 * and temporary ray state, keeping the committed scene. Independent contexts keep
 * independent accumulation. Render/read/reset GPU failures mark the scene failed;
 * commit a new scene before further use. Device-loss recovery is unavailable.
 *
 * read_pixels kind 0=linear HDR, 1=normal, 2=albedo: little-endian f32 RGBA,
 * bottom row first, width*height*16 bytes, divided by completed sample count.
 * Normals are not renormalized. Requires at least one completed sample.
 * pixels=NULL,size=0 queries required size without reading GPU data. written is
 * required; a short destination returns an error and required size without
 * changing destination or scene. A successful read copies the whole image.
 * No file output or Node/JS process is involved. HWRT/denoising are pending.
 */
typedef uint64_t mt_context;
typedef struct mt_context_info_v1 {
  uint32_t struct_size; /* Set to sizeof(mt_context_info_v1). */
  uint32_t version; /* Returned as 1. */
  uint32_t width, height, samples;
  uint32_t state; /* 0=no scene, 1=committed, 2=failed, 3=active job. */
  uint32_t reserved[2]; /* Returned as zero. */
} mt_context_info_v1;
int32_t mt_context_create(mt_context *output, char *error, size_t capacity);
int32_t mt_context_destroy(mt_context handle, char *error, size_t capacity);
int32_t mt_context_commit(mt_context handle, const uint8_t *input, size_t length, char *error, size_t capacity);
int32_t mt_context_render(mt_context handle, uint32_t additional_samples, char *error, size_t capacity);
int32_t mt_context_reset(mt_context handle, char *error, size_t capacity);
int32_t mt_context_info(mt_context handle, mt_context_info_v1 *info, char *error, size_t capacity);
int32_t mt_context_read_pixels(mt_context handle, uint32_t kind, void *pixels, size_t size,
  size_t *written, char *error, size_t capacity);
/* One job per context. submit records the request without GPU dispatch. Poll
 * drives progress on the owner thread, submits at most max_new_samples (0..64)
 * when no batch is in flight, and checks completion without waiting for the GPU.
 * CPU batch preparation/submission still takes time; no fixed latency guarantee.
 * A budget of 0 only checks completion. info reports the last polled snapshot;
 * it does not submit work or advance completion. No background polling thread.
 *
 * requested/submitted/completed counts are additional samples, excluding base.
 * Context info counts only completed samples. Active jobs reject blocking render,
 * reset, commit, read_pixels and destroy. Cancel is idempotent: queued work stops
 * immediately; in-flight work finishes, then poll reaches cancelled or complete.
 * Submitted batches cannot be interrupted. Completed samples remain accumulated;
 * a later job continues the same sequence. Full completion takes precedence over
 * late cancellation. GPU failures mark the scene/job failed; failed contexts may
 * be destroyed or replaced by commit. Device-loss recovery remains unavailable.
 *
 * A job handle expires on the next submit, blocking render, successful reset/
 * commit, or context destruction. Validation-rejected calls retain the job.
 * Handles are never reused. Save any terminal info before starting another job.
 */
typedef uint64_t mt_render_job;
typedef struct mt_job_info_v1 {
  uint32_t struct_size; /* Set to sizeof(mt_job_info_v1). */
  uint32_t version; /* Returned as 1. */
  uint32_t state; /* 0=queued, 1=running, 2=complete, 3=cancelled, 4=failed, 5=cancelling. */
  uint32_t requested_samples, submitted_samples, completed_samples, base_samples;
  uint32_t reserved; /* Returned as zero. */
} mt_job_info_v1;
int32_t mt_context_submit(mt_context handle, uint32_t additional_samples, mt_render_job *job,
  char *error, size_t capacity);
int32_t mt_job_poll(mt_render_job job, uint32_t max_new_samples, char *error, size_t capacity);
int32_t mt_job_info(mt_render_job job, mt_job_info_v1 *info, char *error, size_t capacity);
int32_t mt_job_cancel(mt_render_job job, char *error, size_t capacity);
#ifdef __cplusplus
}
#endif
#endif
