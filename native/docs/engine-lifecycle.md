# Engine lifecycle and extensions

Use Rust `mutracer_native_probe::api` or C
[`mutracer-engine.h`](../include/mutracer-engine.h). Both SDKs are experimental;
API and ABI may change.

## Clearing and loading scenes

`engine.clear_scene()` / `mt_engine_clear_scene` records an empty scene. Call
`update` to commit it, just as after setting a scene. Before update, existing
images remain available. After update, all renders have zero samples, no readable
old image and `Idle` / `MT_RENDER_IDLE` status. The render loop becomes idle and
stops requesting ticks after pending window presentation completes. An attached
window is cleared to transparent black (opaque windows show black); skipped
frames retry through the normal surface status contract. Render handles, settings, camera override and configured
denoisers remain reusable: set another scene and update to resume rendering.

Clear cancels pending preparation, sampling, convergence and denoising. It can
wait for preparation and submitted GPU work to retire, but never joins a denoiser
worker. It releases scene and image resources; device pipeline caches
remain reusable. A converge interrupted by a scene change returns an error.

## Diagnostics and compilation

Call `engine.diagnostics()` / `mt_engine_diagnostics` for current CPU observations.
Rust includes device information, the last error and per-render samples; C uses
`mt_engine_info`, `mt_engine_last_error` and `mt_render_info` for those details.
The query takes O(render count), copies CPU data and does not poll or wait for
GPU completion. It may wait for another API operation using the same engine.
It works with logging disabled; logging is an optional event stream.

Samples count completed batches collected by refine, collect or converge. They
can lag completed GPU work until one of those calls. Captured samples describe
the retained image and may belong to earlier inputs while a new scene prepares.
Pending sampling/denoising counts include work not yet collected. Compilation
counters refresh at compile entry/exit: started and completed count attempts,
including failed attempts; cache hits count reused path-tracing variants.
Cached variants exclude display, depth and postprocessing pipelines and GPU
driver caches. Counts last for the engine device's lifetime, including clears;
they are independent observations during concurrent work, not a GPU memory budget.

`Compiling` / `MT_RENDER_COMPILING` means a path-tracing pipeline cache miss is
being compiled. Cache hits do not enter this stage. Full scene compilation runs
on the preparation thread; first-use render variants can compile on the calling
thread and block it. Compilation progress events report 0 on entry and 1 on
exit, including failed attempts, on the next event-delivering API call; callbacks
stay on that caller's thread. C uses `MT_ENGINE_EVENT_COMPILATION`. The shared
device's active compilation is visible to all its renders. Preparation includes
resource work outside this compilation interval.
