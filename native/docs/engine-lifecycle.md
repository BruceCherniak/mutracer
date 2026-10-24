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
frames retry through the normal surface status contract. Render handles, settings,
camera override and configured denoisers remain reusable: set another scene and update to resume rendering.

Clear cancels pending preparation, sampling, convergence and denoising. It can
wait for preparation and submitted GPU work to retire, but never joins a user
filter callback. It releases scene and image resources; device pipeline caches
remain reusable. A converge interrupted by a scene change returns an error.

## Diagnostics and compilation

Call `engine.diagnostics()` / `mt_engine_diagnostics` for current CPU observations.
Rust includes device information, the last error and per-render samples; C uses
`mt_engine_info` and `mt_render_info` for device and sample details. C errors
are returned in call error buffers and delivered through engine error events.
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
driver caches. At most 32 variants are cached; eviction can require recompilation.
Counts start with each engine and survive scene clears. During concurrent work
they are independent observations. GPU memory estimates are unavailable.

`Compiling` / `MT_RENDER_COMPILING` means a path-tracing pipeline cache miss is
being compiled. Cache hits do not enter this stage. Full scene compilation runs
on the preparation thread; first-use render variants can compile on the calling
thread and block it. Compilation progress events report 0 on entry and 1 on
exit, including failed attempts, on the next event-delivering API call; callbacks
stay on that caller's thread. C uses `MT_ENGINE_EVENT_COMPILATION`. An engine's
active compilation is visible to all its renders. Preparation includes
resource work outside this compilation interval.

## Custom denoisers

Install a Rust `Arc<dyn CustomDenoiser>` with `render.set_custom_denoiser`, or
register `mt_custom_denoiser` with `mt_render_set_custom_denoiser`. Choose the
same converged, progressive or every-sample schedules as OIDN. Passing None/NULL
disables filtering. Existing `set_denoiser` / `mt_render_set_denoiser` OIDN calls
remain available and replace a custom filter.

Progressive and every-sample schedules keep the last filtered image, including
its coverage and catcher layers, visible until the next result. Display settings
still apply to that image; raw HDR and guide readback continue to follow newly
completed samples. Retained composition adds 48 bytes per render pixel in GPU
buffers, plus 48 bytes for catcher scenes. A sealed GPU result also retains
16 bytes per pixel. Disabling the filter or restarting the render releases these
buffers.

By default inputs are owned linear RGBA32F color, normal and albedo arrays,
bottom row first. Color is the raw per-sample average including background;
alpha is path coverage. Return the same layout and size with finite values.
This differs from L1 HDR export's surface-hit normalization. Custom invocations
freeze 48 bytes per pixel in GPU input snapshots so cancellation or later
rendering cannot overwrite their inputs. Filtering and CPU input readback run
on a library thread. Rust `gpu_inputs()` additionally uploads these
CPU arrays; returning `DenoiseOutput::Gpu` reads that buffer back on the worker.
C callbacks use CPU arrays and must perform their own GPU transfers if needed.

For same-device filtering without image readback or CPU upload, return
`DenoiseInputMode::ResidentGpu` from `CustomDenoiser::input_mode()`. The callback
receives `input.resident` with immutable GPU color/normal/albedo buffers, size,
sample count and a unique device/target/generation/frame identity; CPU arrays
are empty. These are the existing accumulation guides, not temporal depth,
motion or RR first-surface inputs. Normal filtering does not change sampling.
See the [GPU identity example](../host/examples/custom-gpu-denoiser.rs).

Record work in separate command buffers and call
`resident.submit(commands, output_buffer)`, then return the sealed result as
`DenoiseOutput::Resident`. Use the supplied device and queue; never destroy them
or mutate the input buffers. Output must contain finite RGBA32F values with the
input orientation and coverage. The library copies it into an owned result and
passes it to Display on the GPU. Explicit pixel reads still read back and check
finite values. GPU snapshots and output retention add device memory and copy
costs; this mode does not remove the existing retained composition buffers.

Save `resident.status()` before submitting when acceptance or resource retirement
matters. Acceptance becomes Accepted only after the result is published, or
Rejected after cancellation, replacement or failure. GPU retirement is a
separate completion flag; rejecting a result cannot cancel submitted GPU work.
The input lease and filter stay alive until that work completes, including when
the engine is disposed. Release of the library's last filter reference runs
off-thread.
Early submissions through `input.gpu` or `resident.gpu` also retain the snapshot
and filter when the callback fails before sealing its output. Finish submissions
before closing the resident frame; its submission handles cannot be reused later.
Returning a CPU image from ResidentGpu keeps the same publication status, with
the CPU upload cost of a CPU result.

In Cpu mode the worker owns input data until callback return. Rust output ownership transfers
to the library. C writes the provided output and retains none of its input,
output, cancellation or error pointers after return. Poll the cancellation token
to stop cooperatively. Cancel, clear, replacement and destruction return without
joining callbacks; cancelled results are discarded. A stuck callback retains its
inputs and filter indefinitely. Replacements can overlap old calls, so filters
must support concurrent access. C user data remains owned until its release
callback runs after the last reference retires; release also runs off-thread.
Keep callback code loaded until release returns. Omit the C release callback
only for process-lifetime code and user data. Filter callbacks must not unwind across
C. Window engines reject callback reentry from worker threads.

Errors, invalid output and caught Rust panics produce a denoise report and engine
error event; scheduled filtering stops until the filter is set again. Converge
returns an error. Filter failures leave the original accumulation available. Cancellation and
timeout also stop converge's wait even when the callback does not cooperate.

## C window presentation

Create a real native window, fill `mt_native_window`, then call
`mt_engine_create_for_window`. It creates and owns a surface-compatible adapter
and device. Obtain the display and present/tick normally. Use
`mt_display_resize_window` for physical dimensions (zero suspends),
`mt_display_detach_window` before releasing native handles, and
`mt_display_attach_window` to replace or restore an attachment on the same device.
The host owns the event loop and keeps native handles alive until detachment,
replacement or engine destruction returns.

Supported handle kinds are macOS NSView (1), Win32 HWND (2), Linux Xlib
Display/Window on screen 0 (3), and Wayland display/surface (4). AppKit requires
the main thread. All calls on a window engine and its objects, including
destruction, must use its creating window thread; `mt_render_cancel` is the
cross-thread exception. See [platform support and validation status](../README.md#platforms).
External native GPU device handles are not imported through C; Rust
`Engine::on_device` supports host-owned wgpu device sharing.

C window options are fixed to vsync and automatic alpha, with SDR initially.
Display settings can request HDR, with SDR fallback. Query `mt_display_surface_info` for attachment, negotiated
format, HDR status/fallback and last presentation result. Offscreen `mt_presented`
can succeed when the window frame is skipped: retry timeout/outdated later, wait
for expose after occlusion and reattach after loss. Device loss remains terminal.
Window acquisition/configuration may block; rendering to the window adds a GPU
draw without CPU readback. Pixel/PNG export stays SDR.

## Browser API counterparts

| Native API | Browser API / difference |
| --- | --- |
| diagnostics | `Engine.getDiagnostics()`; backend-specific counters differ |
| clear scene + update | `engine.scene = undefined; engine.update()`; native empty renders use Idle |
| Compiling / compilation progress | `Render.status === 'compiling'`, progress stage `shaders` |
| CustomDenoiser / C callback | `type: 'custom'` and `Denoiser`; native work uses threads and owned data |
| native window + Display | browser canvas + Display; native host owns window events and thread affinity |
