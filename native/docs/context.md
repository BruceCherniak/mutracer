# Context API

[mutracer-context.h](../include/mutracer-context.h) is the lower-level C API
under the [engine](engine.md): one context holds one committed scene, one
resolution and one accumulation. Use it for a single fixed-size image, or to
drive sampling with polling jobs. Scenes are
[binary descriptors](scene-format.md); `mt_scene_encode` produces one from a
[Scene](scene.md#export-a-descriptor).

## Usage

`create → commit → render → read_pixels → destroy`:

- `mt_context_create` (hardware ray tracing) or
  `mt_context_create_with_backend` creates a context. After a commit,
  `mt_context_backend` reports the path actually used and any
  [fallback reason](../README.md#ray-tracing-backends).
- `mt_context_commit` copies the descriptor and replaces the whole scene. A
  rejected commit keeps the previous scene, settings and samples.
- `mt_context_render` adds samples and blocks until they finish: two calls with
  32 samples give 64. The total is limited to 1–4096.
- `mt_context_read_pixels` copies HDR, normal or albedo pixels into your
  memory: linear RGBA32F, bottom row first, raw per-sample averages. Normals are
  not renormalized. It needs at least one completed sample.
- `mt_context_reset` clears the samples and keeps the scene.

[examples/minimal-host.c](../examples/minimal-host.c) is a complete program.

## Settings

`mt_context_commit` uses Sobol sampling, seed 12345, 6 bounces, 64 maximum
samples, 2 direct-light candidates and 8 bevel samples. To change them,
initialize `mt_render_settings` with `mt_render_settings_default` and pass it to
`mt_context_commit_with_settings`; later renders and jobs keep these settings.
Width, height and the bevel and dispersion quality flags come from the
descriptor. Unknown or unsupported values return an error.

## Commits and edits

- Commit the edited descriptor again to update a scene. Edits listed in
  [Edit a scene](scene.md#edit-a-scene) commit incrementally; render settings
  and resolution changes need full preparation.
  `mt_context_snapshot.last_commit` reports which ran. Every successful commit
  restarts accumulation.
- A full commit prepares on a library thread while the old scene keeps
  rendering, and blocks the committing call; commit from a worker to keep a UI
  responsive. Old and new resources coexist briefly.
- `mt_context_cancel_commit` stops a pending commit after its current step and
  keeps the old scene. `mt_context_destroy` cancels a pending commit and waits
  for it to release its resources.
- A second commit while one is preparing returns `MT_ERROR_INVALID_STATE`.

## Jobs

Jobs request samples without blocking:

1. `mt_context_submit` records a request for more samples; it does no GPU work.
2. `mt_job_poll` from any thread submits at most `max_new_samples` (0–64) when
   no batch is in flight, and checks completion without waiting for the GPU. A
   budget of 0 only checks. Polling still takes CPU time to prepare batches;
   latency is not fixed.
3. `mt_job_info` returns the last polled state without advancing work.

- `mt_job_cancel` stops further submissions. A submitted batch still finishes,
  so keep polling until the job reports cancelled or complete. Full completion
  wins over a late cancel.
- Completed samples stay accumulated, and a later job continues the same
  sequence.
- One job per context. While it is active, `mt_context_render`, `reset`,
  `read_pixels` and `destroy` return `MT_ERROR_INVALID_STATE`; finish or cancel
  and drain it first.
- A commit can prepare while a job runs; publishing the new scene drains the old
  job.
- A job handle expires on the next submit, blocking render, successful reset or
  commit, or destruction. Save its final info before starting another job.

[examples/job-host.c](../examples/job-host.c) shows polling from several
threads, cancellation and resuming.

## Threads

Calls may come from any thread. Short operations serialize, and an overlapping
call can return `MT_ERROR_BUSY`; retry it. There is no fixed limit on the number
of contexts, but GPU memory is finite. `mt_context_wait` waits for submitted GPU
work with a timeout; while it waits, calls on other contexts return
`MT_ERROR_BUSY`.

## Failures

GPU failures during render, readback, reset or an incremental commit return
`MT_ERROR_CONTEXT_FAILED`; later calls return `MT_ERROR_INVALID_STATE` until a
successful commit, or destroy the context. Device-loss recovery is not
available.
