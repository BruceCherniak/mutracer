# Engine API

Rust `mutracer_native_probe::api` and C
[mutracer-engine.h](../include/mutracer-engine.h) follow the browser library's
object model:

- **Engine**: the GPU device and the committed scene and camera.
- **Render**: an independent accumulation with its own size and settings.
- **Display**: tone mapping, presentation and image export; see
  [Display](display.md).
- **RenderLoop**: the interactive preview/final policy.

## Render offline

1. Create an engine and a render.
2. Set the scene (`set_scene_object`, or `set_scene` with a
   [descriptor](scene-format.md)) and call `update`.
3. Call `converge` / `mt_render_converge` with the sample count. It blocks until
   the samples complete, then runs the render's denoiser if one is set.
4. Read linear pixels with `read_pixels` / `mt_render_read_pixels`, or display
   RGBA8/PNG with `mt_display_read_pixels`.

The [quick start](../README.md#quick-start) shows the complete sequence.
`mt_render_cancel` from another thread stops a converge with
`MT_ERROR_CANCELLED`. `mt_converge_options.use_camera` renders one output from
another camera without changing the engine camera.

## Render interactively

Create an engine, set the scene and create a render loop. Each frame, call
`mt_render_loop_tick` while `mt_render_loop_needs_tick` reports work. A tick
runs syncs, commits with `update`, selects the preview or final render, refines
it and presents it.

- The loop owns a final render and, by default, a preview render at half
  resolution that adapts down to 1/8; the final render presents the preview as
  its fallback.
- `mt_render_loop_add_sync` registers callbacks that write the latest
  application state to the engine before each commit and report whether more
  changes are expected (for example during a drag).
- Hosts that schedule renders themselves call `mt_render_refine` and
  `mt_display_present`.

## Updates

`set_scene_object`, `set_scene`, `set_camera` and `clear_scene` only record
inputs; `update` commits them, once for all renders.

- Incremental edits ([which ones](scene.md#edit-a-scene)) finish during
  `update`.
- Full preparation runs on a library thread. Previous images stay readable and
  presentable, and renders report `Preparing` / `MT_RENDER_PREPARING` or
  `Compiling` / `MT_RENDER_COMPILING` until the new scene is published.
- Each render uses its own width, height, bevel and dispersion settings, and the
  engine camera when one is set. Changing one render's size or settings restarts
  only that render.

### Clear the scene

`clear_scene` / `mt_engine_clear_scene` records an empty scene; `update` commits
it. Until then, existing images stay available. After it:

- Renders have zero samples, no readable image and `Idle` / `MT_RENDER_IDLE`
  status. The render loop stops requesting ticks after pending window
  presentation.
- An attached window shows transparent black (opaque windows show black).
- Pending preparation, sampling, convergence and denoising are cancelled; a
  converge interrupted this way returns an error. Clearing can wait for
  preparation and submitted GPU work, but never for a custom denoiser callback.
- Scene and image resources are released; pipeline caches stay.
- Render handles, settings, the camera override and denoisers remain usable:
  set another scene and update to continue.

## Render options

Options default to the browser library's values: 2048 maximum samples, 3
bounces, 4 direct-light candidates, bevel with 8 samples, 3 dispersion
wavelengths, seed 12345, the display size at scale 1, and a 21 ms frame budget.
The [context API](context.md#settings) has different defaults. The header and
Rust `RenderSettings` document every option and range.

C callers initialize `mt_render_options` with `mt_render_options_default`; the
record is 112 bytes and `struct_size` must match.

### Alpha blend strategy

The default, `Stochastic` / `MT_ALPHA_BLEND_STOCHASTIC`, randomly accepts or
skips blend coverage. `DeterministicSourceOver` /
`MT_ALPHA_BLEND_DETERMINISTIC_SOURCE_OVER` combines front and back contributions
of primary rays every sample. It reduces coverage noise at extra GPU cost;
secondary rays stay stochastic.

```c
mt_render_options options;
mt_render_options_default(&options);
options.alpha_blend_strategy = MT_ALPHA_BLEND_DETERMINISTIC_SOURCE_OVER;
mt_render_set_options(render, &options, error, sizeof error);
```

In Rust, set `RenderSettings::alpha_blend_strategy`. Both strategies work with
RGB and spectral rendering on both backends; opaque and masked materials are
unaffected. Coverage controls visibility, independent of physical transmission.
A change restarts only that render at its next update or refine. The first use
of a strategy can compile a shader and block that call.

### Depth samples

`Engine::read_depth_samples` / `mt_engine_read_depth_samples` returns a 7×7 grid
of depths from the committed engine camera, for example for autofocus:

```rust
use mutracer_native_probe::api::DepthSampleArea;
let samples = engine.read_depth_samples(DepthSampleArea {
    x: 0.5, y: 0.5, size: 0.07,
})?;
// Some([f32; 49]) when ready; None while the scene is preparing.
```

- Call `update` first. No render or completed sample is needed. While the scene
  is preparing, Rust returns `None` and C writes 0 samples; retry later.
- `x` and `y` are centers in 0–1 from the left and top. `size` is the half
  height divided by the viewport height; 0 repeats one point.
- The camera is the last committed one (or the scene's), with the display's
  aspect ratio. Render sizes and converge camera overrides do not apply.
- Values are top row first, measured along the camera's forward axis in scene
  units. Misses and samples outside the viewport are 0.
- Rays have no jitter or depth of field. They pass through alpha holes and
  invisible shadow catchers for up to 32 layers and stop at other surfaces.
- The call blocks for GPU readback and can compile a pipeline on first use;
  query when needed, not every frame. It does not change samples, images or
  denoising.
- C `count` and `written` are float counts (49), not bytes. A NULL destination
  with count 0 queries readiness.

## Diagnostics and compilation

`diagnostics()` / `mt_engine_diagnostics` returns current CPU-side counters
without polling the GPU; it costs O(render count) and works with logging
disabled. Rust includes device information, the last error and per-render
samples; C uses `mt_engine_info` and `mt_render_info` for those.

- Sample counts include only batches collected by refine, collect or converge,
  so they can lag the GPU. During preparation, captured samples describe the
  retained older image.
- `compilations_started` and `compilations_completed` count attempts, including
  failures; `pipeline_cache_hits` counts reused path-tracing variants. Counters
  start with each engine and survive scene clears.
- Up to 32 path-tracing variants are cached; eviction can require recompiling.
  Display, depth and post-processing pipelines are not counted.
- `Compiling` means a path-tracing pipeline cache miss is compiling. Full scene
  compilation runs on the preparation thread; a first-use render variant can
  compile on the calling thread and block it.
- Compilation events (`MT_ENGINE_EVENT_COMPILATION`) report 0 on entry and 1 on
  exit, delivered on the next event-delivering call.
- GPU memory estimates are not available.

## Threads and callbacks

- Call an engine and its objects from any thread, one thread at a time. Only
  `mt_render_cancel` may run concurrently.
- [Window engines](display.md#c-window-presentation) must be used on their
  creating window thread.
- Event and progress callbacks run synchronously inside `update`,
  `read_depth_samples`, `refine`, `converge` and render-loop calls. They may call
  the API, except the render loop that is running them.
- [Custom denoiser](denoising.md#custom-denoisers) callbacks run on library
  threads.

## Device loss

Device loss is terminal for an engine; dispose it and create a new one.

- Its renders and loops enter `Error`. Rendering, updates, presentation and
  readback return `Status::Unavailable` / `MT_ERROR_UNAVAILABLE`, and
  `last_error` keeps the message until disposal.
- The next `update`, `refine`, `converge` or `tick` delivers one `DeviceLost`
  event (`recovering = false`) and one `Error` event on the calling thread.
  `needs_tick` requests one final tick for undelivered events.
- A pending converge returns without waiting for running preparation or
  denoising, whose results are discarded. Disposal can still wait for
  preparation to release its resources.

`Engine::new` and C engines handle the device notification themselves. Rust
hosts using `Engine::on_device` must forward their wgpu device-loss callback to
every engine sharing the device:

```rust
let loss = engine.device_loss_notifier();
device.set_device_lost_callback(move |reason, message| {
    loss.notify(format!("{reason:?}: {message}"));
    // Keep the application's other device-loss handling here.
});
```

Notifiers can be cloned, called from any thread and outlive the engine; they
keep the first reason and do not call user callbacks.

## Differences from the browser library

| Native | Browser | Difference |
| --- | --- | --- |
| `converge` | `render.converge()` | Blocks the calling thread |
| `mt_render_loop_tick` | `RenderLoop.start()` | The host calls tick each frame |
| Adaptive resolution | `adaptiveResolution` | Evaluated when each batch completes, not one frame later |
| Denoising | OIDN, JNLM, custom | OIDN or a custom filter; no tiles or adaptive sampling |
| Custom denoisers | `{type: 'custom'}` | Run on library threads with owned arrays |
| `diagnostics` | `Engine.getDiagnostics()` | Backend-specific counters differ |
| Clear scene + update | `engine.scene = undefined; engine.update()` | Empty renders report Idle |
| `Compiling` and compilation events | `status === 'compiling'`, progress stage `shaders` | — |
| Window + Display | Canvas + Display | The host owns window events and thread affinity |
