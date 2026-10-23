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
completed samples. Retaining a filtered result adds 48 bytes per render pixel
in GPU buffers, plus 48 bytes for catcher scenes. Disabling the filter or
restarting the render releases these buffers.

Inputs are owned linear RGBA32F color, normal and albedo arrays, bottom row
first. Color is the raw per-sample average including background; alpha is path
coverage. Return the same layout and size with finite values. This differs from
L1 HDR export's surface-hit normalization. Input readback can block the API call;
filtering runs on a library thread. Rust filters can request GPU input buffers
with `gpu_inputs()`, use the supplied device and coordinated GPU submission
access, and return a CPU array or a COPY_SRC GPU buffer on that device. GPU input
currently adds an upload after readback; GPU output adds worker-side readback.
C callbacks use CPU arrays and must perform their own GPU transfers if needed.

The worker owns input data until callback return. Rust output ownership transfers
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
cross-thread exception. The C window consumer is verified on macOS Metal;
Windows/Linux window paths remain experimental and runtime-unverified.
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
