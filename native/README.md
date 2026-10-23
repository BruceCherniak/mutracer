# Experimental native renderer

MuTracer's experimental C interface accepts raw scene data and renders through
native machine code and wgpu, without a JavaScript engine or Node at runtime.
It supports part of MuTracer and has an unstable ABI.

## Platforms

| Platform | GPU API | Status |
| --- | --- | --- |
| macOS arm64 | Metal | Supported; physical GPU rendering verified |
| Linux x64 | Vulkan | Supported; hardware-specific behavior and performance unverified |
| Windows x64 | DX12 or Vulkan | Experimental; CI builds only, no release packages |

The headers in [`include/`](include) and the [native viewer](./viewer/README.md)
follow this table. Native denoising backends depend on the OIDN runtime; see
[Denoise caller-owned images](#denoise-caller-owned-images). Performance varies
by scene and hardware.

## Native viewer

Run `npm run native:viewer` for a standalone GLTF/GLB viewer with material, render
and environment controls. See [viewer usage and limits](./viewer/README.md).

## Render a scene

Building requires Rust, a C++20 compiler (Xcode Command Line Tools on macOS), project npm
dependencies and a separately installed scriptc **0.3.2**. See the
[platform prerequisites](./viewer/README.md#build-and-open) for Windows and Linux.

```sh
export MUTRACER_SCRIPTC=/absolute/path/to/node_modules/.bin/scriptc
npm run native:scene
```

The command builds the library and C example, renders the supported example
scenes and verifies scene preparation. Node is required for this build and
verification command. The resulting C consumer renders without Node or prepared
capture files:

```sh
.native-build/scene-core/scene-host /absolute/output/directory 256 v2-environment
```

Examples include `baseline`, `textures`, `transforms`, `orthographic`, `emissive`,
`alpha`, `v2-environment`, `v2-background`, `v2-hidden-background`, `v2-film`,
`v2-medium`, `v2-bevel`, `v2-vertices`, `v2-multimaterial` and `v2-instances`.
The example host uses `mt_probe_render_scene` from
[mutracer-debug.h](include/mutracer-debug.h), a debug and validation entry point
that may change without notice. Applications render caller-supplied data with
the [engine API](#render-with-the-engine-api) or the lower-level
[context API](#keep-a-scene-alive-and-read-pixels).
[examples/minimal-host.c](examples/minimal-host.c) is a complete program of
about 50 lines: it builds a scene with the header-only builder in
[mutracer-scene-builder.h](include/mutracer-scene-builder.h), commits it,
renders and reads HDR pixels. The [scene format reference](docs/scene-format.md)
documents every record. Add `native/include` to your C compiler's header search
path.

The example's output directory contains `render.png`, `render.rgba32f`, `normal.rgba32f`,
`albedo.rgba32f` and `result.json`. The PNG is a Reinhard/sRGB preview. Float files
contain linear sample averages as little-endian f32 RGBA, bottom row first;
dimensions are in `result.json`. Normal guides are not renormalized after averaging.

## Render with the engine API

```sh
npm run native:engine
```

[mutracer-engine.h](include/mutracer-engine.h) provides the object model of the
browser library. An engine owns the device and the committed scene and camera.
Each render is an independent accumulation with its own size and settings. The
display tone-maps, presents and exports images, and a render loop runs the
interactive policy. Rust hosts use the same objects through
`mutracer_native_probe::api`.
[examples/engine-host.c](examples/engine-host.c) renders one descriptor through
an engine, a render and a render loop and compares the images with a fresh
context. The command above builds it, runs it on four scenes with both backends
and saves the results under `.native-build/engine/`.

An interactive host creates an engine, sets the scene, creates a render loop and
calls `mt_render_loop_tick` every frame while `mt_render_loop_needs_tick`
reports work. An offline host creates a render, calls `mt_engine_update`, then
`mt_render_converge`, and reads the image with `mt_render_read_pixels` (linear
floats) or `mt_display_read_pixels` (RGBA8 or PNG with the display settings).

`mt_engine_set_scene` and `mt_engine_set_camera` only record the inputs;
`mt_engine_update` commits them. The engine prepares its scene once for all
renders. Edits that a context applies incrementally
([Editing a scene](#editing-a-scene)) finish during the call. Full preparation
runs on a library thread while the previous images stay readable and
presentable, and renders report `MT_RENDER_PREPARING` until it is published.
Each render uses its own width, height, bevel and dispersion settings and, when
set, the engine camera instead of the descriptor's. Changing a render's size or
settings restarts only that render.

Render options default to the browser library's values (2048 samples, 3
bounces, 4 light candidates, bevel, 3 dispersion wavelengths); context
settings keep their own defaults. Images are top row first. Use an engine and
its objects from one thread at a time; only `mt_render_cancel` may be called
from another thread. Callbacks run synchronously inside the calls that produce
them. The header documents every option, default, error and lifetime.

Differences from the browser library:

- Adaptive resolution evaluates each batch when it completes rather than one
  display frame later.
- Converge blocks its thread. The host drives the loop with
  `mt_render_loop_tick` instead of start and stop.
- Denoising uses OIDN only. Tiles, alpha blend strategies and adaptive sampling
  are not available.

### Depth samples

Query a square 7×7 grid from the committed engine camera with Rust
`Engine::read_depth_samples` or C `mt_engine_read_depth_samples`:

```rust
use mutracer_native_probe::api::DepthSampleArea;
let samples = engine.read_depth_samples(DepthSampleArea {
    x: 0.5, y: 0.5, size: 0.07,
})?;
// Some([f32; 49]) when ready; None while the scene is unready/preparing.
```

Commit scene/camera changes with `engine.update()` first. Queries need no Render
or completed beauty sample; retry later while preparation is pending. The camera
comes from the last update, falling back to the scene descriptor's camera, and
uses the current Display width/height ratio. Render sizes and converge camera
overrides do not affect it.

`x` and `y` are finite centers in 0–1, from the left and top. `size` is the
nonnegative half height divided by viewport height; 0 repeats one point 49 times.
The grid is top-row-first. Depth is distance along camera forward in scene units,
not distance along the ray. A miss or out-of-viewport sample is 0. Pinhole rays
have no jitter or depth of field, skip alpha holes and invisible shadow catchers
through at most 32 layers, and stop on other surfaces with positive alpha.

The call blocks for GPU readback and can compile a query pipeline on first use;
query as needed rather than every display frame. Querying a ready scene leaves
render samples, images and denoising unchanged. C `count`/`written` are float
counts, not byte counts: allow 49 floats; `written = 0` means retry later. C buffer and size-query
rules are in [`mutracer-engine.h`](include/mutracer-engine.h).

### Display effects

Set effects through Rust `DisplaySettings` or C `mt_display_settings` before
presentation or pixel/PNG export. They do not restart accumulation or change HDR
readback. For example:

```c
mt_display_settings settings;
mt_display_settings_default(&settings);
settings.vignette = 0.4f;
settings.bloom_intensity = 0.2f;
mt_display_set_settings(display, &settings, error, sizeof(error));
```

Vignette strength is 0–1 (default 0). Bloom intensity is nonnegative (default 0,
disabled), its luminance threshold defaults to 1, and its radius is 0–1 (default
0.6). Bloom starts at ten samples and refreshes every ten samples, or when its
threshold, radius or denoised input changes. It adds GPU work and retains roughly
51 bytes per render pixel in image caches; very small images cost more per pixel.
These caches remain until the render changes size or is disposed.

Materials marked as shadow catchers show the background with received shadows.
`shadow_catcher_color` defaults to black and `shadow_catcher_alpha` to 1 (range
0–1). Reducing alpha subtracts from the estimated shadow opacity, so faint
shadows disappear first. Catcher scenes retain an additional 48 bytes per render
pixel. The `ShadowCatcher` / `MT_CHANNEL_SHADOW_CATCHER` channel shows raw coverage,
background alpha/hits and shadow opacity; `Shadow` / `MT_CHANNEL_SHADOW` shows the
same image as `Final`, matching the browser WebGPU pipeline.

Effects apply before custom display passes and scaling. Normal and albedo
channels bypass them. An opaque, solid background keeps its color independently
of exposure, grading and vignette; it can still receive bloom spill and catcher
shadows. Transparent and mapped backgrounds use the display transforms. Native
output keeps its sRGB transfer. OIDN filters the original HDR; catcher layers use
that filtered color, while shadow opacity remains unfiltered, so shadow noise
can remain after denoising.

C callers using the current header get all effect defaults. Other FFI bindings
should initialize the current 68-byte record with `mt_display_settings_default_sized`.
Existing 32- and 64-byte records remain accepted; omitted fields use defaults.

### Rust GPU images and display passes

Use `Render::get_output_texture` with `OutputKind::Hdr` or `OutputKind::Display`
to borrow an image on the engine's device without a CPU readback. GPU hosts can
use their own device and queue through `Engine::on_device`. Encode and submit
commands using the image before the next refine/converge, display present/resize,
restart, disposal or device loss; do not retain, write or destroy it.

HDR is top-row-first RGBA32Float resolved ray color and coverage, before denoising
and display settings. RGB is normalized by surface hits as on WebGPU;
`read_pixels(PixelKind::Hdr)` keeps the native per-sample average. Display is the
latest composition including passes, in straight-alpha, sRGB-encoded RGBA8Unorm
at the actual render size. Before a complete captured sample, the method returns
`None`; Display also needs a previous presentation or export. Borrowing HDR or
an unfiltered display image can enqueue a GPU resolve. RGBA32Float sampling requires an unfilterable texture binding unless
the host enabled float32 filtering.

Add synchronous passes with `Display::add_post_process`. For example, an identity
pass copies its input to its output:

```rust
let display = engine.display();
let pass = display.add_post_process(|ctx| {
    ctx.encoder.copy_texture_to_texture(
        ctx.input.as_image_copy(), ctx.output.as_image_copy(), ctx.input.size(),
    );
    Ok(())
})?;
display.present(&render)?;
// Remove this pass with pass.remove(), or by dropping pass.
```

Passes run in registration order after composition and before display scaling,
on every presentation and export. Each receives the selected complete render
(including a fallback), its actual size, and borrowed straight-alpha RGBA8Unorm
input/output textures. Fully write the output with storage, render or copy
commands in the supplied encoder. Passes do not trace or invalidate denoising.
The default is no passes. Registration and removal take effect on the next
composition; a finished render loop wakes to present those changes.

A returned error or callback panic discards the whole chain, uses the original
composition and reports an engine error. Render inspection and pass registration
are allowed in a callback; nested composition is rejected. Changing or releasing
the selected image during a callback rejects that composition. Images and encoder
are borrowed only for the call. GPU commands must follow wgpu's validation rules.

Extra image caches are allocated on demand per render: HDR uses 16 bytes per
pixel; straight display composition uses 4, with two additional 4-byte images
when passes run. These caches remain until replaced for another size or released
with the render. These interfaces are Rust-only; the C API keeps CPU pixel export.

### Rust window presentation

Create a wgpu surface from an owned window (for example `Arc<winit::window::Window>`),
select a compatible adapter with `compatible_surface`, and create the engine
with `Engine::on_device` using that adapter's device and queue. The instance,
adapter and surface must belong together. Attach the surface to the display:

```rust
use mutracer_native_probe::api::SurfaceOptions;

let display = engine.display();
display.set_size(width, height)?; // physical pixels
display.attach_surface(surface, SurfaceOptions::default())?;
// Display::present and RenderLoop::tick now also present to the window.
render_loop.tick()?;
// On window resize, including zero dimensions when minimized:
display.resize_surface(new_width, new_height)?;
```

The [complete window example](viewer/examples/surface.rs) shows device creation
and event handling. The host owns the event loop and must follow its window
system's presentation notification rules (such as winit `pre_present_notify`).
While attached, call the engine and its objects, including disposal, on the
window thread.
Share one `SubmissionGate` across native engines using that device, and
coordinate other queue users with surface configuration. This window API is
Rust-only; C keeps
offscreen presentation and pixel/PNG export.

Default options select SDR RGBA/BGRA8, vsync and automatic alpha, preferring an
opaque window when supported.
`SurfaceOptions` also accepts an explicit supported format, present/alpha mode
and queued-frame limit. Presentation adds a fullscreen GPU draw and window
framebuffers, with no CPU pixel readback. Frame acquisition and reconfiguration
can block. Effects, custom passes and scaling are included; pixel and PNG exports
remain unchanged.

Inspect `surface_info().status` after presentation. `Display::present` still
reports the offscreen image when a window frame is skipped. Timeout or occlusion
skips a frame; schedule a later frame, or wait for an expose/restore event while
occluded rather than polling continuously. An outdated surface is reconfigured
and retried once. A lost surface must be recreated by the host and attached
again; it does not make the engine unusable. `detach_surface` returns the window
surface and leaves rendering usable offscreen.

A zero window dimension suspends window presentation while keeping the last
positive display/render size. Restoring a positive size resumes presentation;
scale-sized renders resize at their next refine. Attachment, resize and pending
window frames wake a finished render loop. Device loss releases the attachment
and follows the terminal behavior below.

### HDR window output

Request HDR after attaching a window surface, or before attachment:

```rust
let mut settings = display.settings();
settings.hdr_output_enabled = true;
display.set_settings(settings)?;
render_loop.tick()?;
let info = display.surface_info().unwrap();
// info.hdr_active reports the negotiated output route.
```

The default is false. With `SurfaceOptions::format = None`, HDR uses
RGBA16Float with extended linear sRGB (scRGB) when supported. An explicit SDR
surface format pins output to SDR. Unsupported HDR requests also fall back to
SDR; `surface_info()` reports the requested/active state, color space and fallback
reason. Changes apply to the window on the next presentation. A finished render
loop wakes on changes without restarting accumulation.
Changing HDR mode inside a display pass is rejected.

HDR preserves values above 1 and bypasses the display tone mapper. Exposure,
grading, vignette, bloom and catcher composition still apply. The HDR window
image uses linear values, with 1 representing SDR reference white. Actual
brightness above white depends on the OS and display's available headroom;
`display_hdr_info()` queries that live information on the window thread, with
unknown fields left unset. Negotiating HDR does not prove that the panel can
currently show brighter highlights. HDR10/PQ, HLG and wide-gamut output are not
provided.

`Display::texture()`, pixel/PNG export and existing `add_post_process` callbacks
keep their SDR RGBA8 behavior. Register HDR-window passes separately with
`add_hdr_post_process`: they receive straight-alpha linear RGBA16Float images
and run before scaling, only while HDR output is active. Their order, failure
fallback, removal and callback lifetime follow the SDR pass rules. HDR passes do
not change SDR exports; SDR passes affect the SDR preview/exports only.
`Display::hdr_texture()` borrows the latest display-sized premultiplied linear
RGBA16Float window image until the next present/resize. It returns `None` before
an HDR image is presented or while HDR is inactive. Do not write, destroy or
retain it.

HDR keeps the SDR preview alongside the floating window image, adding a GPU
composition and scale per presentation. Its caches add 8 bytes per render pixel,
16 more when HDR passes run, and 8 bytes per display pixel. Render caches remain
until size replacement or disposal; the display HDR image is released on disable
or detach. C accepts the HDR request field in its 68-byte settings record, but
its offscreen pixel/PNG exports remain SDR.

### Device loss

Device loss is terminal for an engine. Its renders and render loops enter
`Error`; rendering, scene updates, presentation and readback return
`MT_ERROR_UNAVAILABLE` (`Status::Unavailable` in Rust). `last_error` keeps the
loss message until disposal. Dispose the engine and create a new one to render
again; there is no automatic recovery.

After receiving the device notification, the next `update`, `refine`, `converge`
or render-loop `tick` delivers one `DeviceLost` event with `recovering = false`,
then one `Error` event, on the calling thread. Pending convergence returns
without waiting for an already running scene preparation or denoiser to finish;
their late results are discarded. Disposal can still wait for scene preparation
to release its resources.
`needs_tick` requests one final tick to deliver undelivered loss events, then
returns false.

`Engine::new` handles device notifications automatically. Rust hosts using
`Engine::on_device` must forward their wgpu device-loss callback to the notifier
of every engine sharing that device. `on_device` preserves the host's callback.
For example, add this notification to the host's existing callback handling:

```rust
let loss = engine.device_loss_notifier();
device.set_device_lost_callback(move |reason, message| {
    loss.notify(format!("{reason:?}: {message}"));
    // Keep the application's other device-loss handling here.
});
```

Notifier clones are safe to call from any thread, keep the first reason, and
may outlive the engine. A notifier does not invoke user callbacks.

## Denoise caller-owned images

Use [mutracer-denoise.h](include/mutracer-denoise.h) to
`create → run → destroy` a native OIDN denoiser. Supply matching linear RGBA32F
HDR, normal and albedo images, such as those returned by `mt_context_read_pixels`.
Choose automatic Metal/CUDA/HIP/CPU fallback or an explicit CPU, Metal, CUDA or
HIP backend. GPU backends require supported hardware and a compatible driver;
HIP also needs its matching AMD HIP runtime; see
[OIDN's system requirements](https://github.com/RenderKit/oidn/blob/v2.5.1/README.md#system-requirements).
Automatic selection falls back to CPU when no supported GPU backend can initialize.
Output keeps the input alpha and can reuse an input buffer; a failed call leaves
output unchanged.
Rendering accumulation is independent of denoising.

Provide OIDN **2.5.1** and matching device modules through an explicit library path
or `MUTRACER_OIDN_LIBRARY`; the standalone viewer already includes them. The native
library does not bundle that runtime. Denoising blocks and uses additional image
buffers. Calls may come from any thread; overlapping operations return
`MT_ERROR_BUSY`.
Images are limited to
4,194,304 pixels. See the header for exact limits, thread rules
and memory ownership. Browser/native denoising parity is not guaranteed.

## Keep a scene alive and read pixels

```sh
npm run native:context
```

The lower-level context API under the engine API: one context holds one scene,
one resolution and one accumulation. Use
[mutracer-context.h](include/mutracer-context.h) for
`create → commit → render → read_pixels → destroy`. Rendering adds samples;
for example, two calls with 32 samples produce 64 accumulated samples. Readback
copies HDR, normal or albedo pixels into caller-owned memory. The context API
has no file output. The command above builds the C consumer and saves its
verified images under `.native-build/context-core/`.

Commit replaces the full scene and restarts accumulation. A rejected commit
retains the previous scene.
Reset clears sampling while keeping the committed scene. Contexts have independent
accumulation. Calls may come from any thread; overlapping operations can return
`MT_ERROR_BUSY`. There is no fixed context-count limit, but GPU memory limits apply. Full
commit preparation allows the previous scene to keep rendering and can be
cancelled with `mt_context_cancel_commit`. Destroy waits for pending preparation
to release its resources. Commit blocks its calling thread; use an application
worker to keep the UI responsive. Commits briefly retain old and new resources together.
The header specifies byte lengths, ownership, errors and remaining limits.
Transform inputs and GPU matrices use Float32; CPU matrix calculations keep
Float64 intermediates. Input and GPU precision still limit large coordinates.

### Editing a scene

To change a committed scene, edit the descriptor and commit it again. The
library compares it with the committed descriptor and, when it can, applies
only the difference: geometry, acceleration structures and pipelines stay
prepared, and only the changed data is uploaded. This incremental commit covers
the camera, mesh and instance matrices, instance colors, vertex positions with
unchanged topology, material parameters and textures, adding, removing and
changing lights, and environment and background map pixels and sizes. Several
edits can share one commit. The rendered images are identical to a full
preparation of the same descriptor.

These edits prepare the scene again: index or vertex counts, adding, removing
or reordering meshes, instance counts, texture counts, displacement map pixels,
adding or removing a map, hiding the background, render settings or resolution,
and material changes that need another shader variant (for example enabling a
medium, or a texture atlas that grows). `mt_context_snapshot.last_commit`
reports `MT_COMMIT_INCREMENTAL` or `MT_COMMIT_FULL` for the last successful
commit. Every successful commit restarts accumulation and expires the previous
job.

An incremental commit still reads the whole descriptor: on a 42 MB scene an
edit commits in about 4 ms, plus the time your application takes to write the
descriptor; a 14 MB scene takes about 2 ms. Keep one descriptor buffer and
change values in place where possible. Run `npm run native:camera` to build and
verify camera edits from C; results are saved under `.native-build/camera-core/`.

## Intersection backend

`mt_context_create` defaults to HWRT. `mt_context_create_with_backend` accepts
`MT_BACKEND_SOFTWARE` or `MT_BACKEND_HWRT`. Query `mt_context_backend` after committing to
verify the actual path. Unsupported devices and acceleration-structure limits
or allocation failures fall back to software and report the reason.

HWRT supports alpha materials, bevel, displacement and general affine instances.
The backend status reports how many geometries use a software BVH; currently
this is zero. Hardware acceleration structures add build time and memory use; a
speedup depends on the
scene and hardware.

Coplanar or overlapping surfaces can resolve to different triangles in software
and HWRT, changing the image.

On Apple M4 Max with macOS 27.0.1, a sample can occasionally see an empty scene
or fail to accumulate without a reported error. This has been observed at
8×8 and 96×64 while other GPU users, including ordinary background apps,
are active. At 1920×1080, about 620,000 dispatches over three hours, mostly
under additional GPU load, showed no occurrences; this does not guarantee
absence at other resolutions or workloads. An affected sample can cause an
abnormal preview frame or a small offline-image bias and break byte-for-byte
repeatability. For precise, reproducible output, render again and compare the
results. Software can also lose samples during GPU recovery, so it is not a
complete substitute. HWRT remains the default; production rendering does not
detect or retry these samples.

## Render with polling and cancellation

```sh
npm run native:jobs
```

Use `mt_context_submit` to request additional samples, then call `mt_job_poll`
from any thread to submit batches and observe completion. Each poll accepts
a budget of 0..64 new samples; zero only checks completion. Submit performs no
GPU work, and polling does not wait for GPU completion. Polling still costs CPU
time to prepare and submit a batch; this is not a fixed-latency interface.
`mt_job_info` returns the last polled snapshot without advancing work. The
command above builds the C example and saves verified images under
`.native-build/job-core/`.

Cancel stops further submissions. An already submitted batch finishes before
poll reports cancellation, so keep polling after cancel. Completed samples stay
accumulated and a later job can continue them. Full completion takes precedence
over late cancellation. One context accepts one active job; while active, render,
reset, readback and destroy return errors. A commit can prepare alongside the
active job; successful publication drains the old job before replacing the scene. Finish or cancel and drain a job before
using the other calls. The header
specifies job states, sample counters and handle lifetimes.

## Scene inputs and options

Scenes are passed as raw descriptor **version 4**, documented in the
[scene format reference](docs/scene-format.md). It supports indexed triangles
with optional normals, tangents, two UV sets, vertex colors and per-vertex
materials; shared geometry, material tables and instance batches; perspective
and orthographic cameras with depth of field; RGBA8 sRGB and RGBA32F linear
textures; rectangular, spherical, directional and spot lights, emissive meshes,
rectangular-light textures and spot-light IES profiles; environment and
background maps; and every OpenPBR material property through
[material property IDs](include/mutracer-material-properties.h), including
displacement. Displacement's cross-backend color and normal parity remains
unresolved.

Additional examples are `v3-displacement-uv`, `v3-displacement-triplanar`,
`v3-ies`, `v3-ies-shared` and `v3-rect-texture`.

Scene commits copy their inputs and retain no caller storage.
`mt_context_render` blocks until rendering finishes; jobs use the polling lifecycle
above. Keep borrowed input/output storage valid until the call returns. Context
render calls retain the committed scene. Samples range from 1 to 4096. `mt_context_commit` defaults to Sobol, seed
12345 and six bounces. `mt_context_commit_with_settings` accepts the sampling
pattern, sequence, bounce and quality options in the context header. Unknown
or unsupported fields return an error.

Build/run settings:

- `MUTRACER_NATIVE_OUTPUT`: output directory; defaults are `.native-build/scene-core/`
  for `native:scene`, `.native-build/context-core/` for `native:context` and
  `.native-build/job-core/` for `native:jobs`; `native:camera` uses
  `.native-build/camera-core/` and `native:engine` uses `.native-build/engine/`.
- `MUTRACER_NATIVE_SAMPLES`: verification samples, default 256; range 1..4096
  for scene verification, 8..4096 for context, job and camera verification.
- `CARGO_TARGET_DIR`: optional reusable Cargo build directory.
- `CC`: C compiler executable, default `cc`.

## Limits

Scene size, count and texture limits are listed in the
[scene format reference](docs/scene-format.md#limits).

Every C API call returns `MT_OK` (0) or a nonzero `mt_status` from
[mutracer-status.h](include/mutracer-status.h), plus an optional message for
people. Branch on the code rather than the message: retry `MT_ERROR_BUSY` and enlarge the
destination after `MT_ERROR_BUFFER_TOO_SMALL`. Treat an unknown nonzero code as
a failure; later versions may add codes. The same header names the backend,
image kind, context/job state, sampling pattern and denoiser backend values.
When loading the library dynamically, compare `mt_abi_version()` with the
`MT_ABI_VERSION` you compiled against. Structs exchanged with the library start
with `struct_size`; set it to `sizeof` the struct before each call.

Validation and preparation errors preserve the current scene.
`MT_ERROR_CONTEXT_FAILED`, including a caught Rust panic, marks the context
failed; replace its scene with a successful commit or destroy it before reuse. Rust's process-wide panic hook can still emit panic diagnostics.
Fatal runtime errors, including allocation failure and abort, terminate
the process and cannot become C API errors. Applications that require recovery
from these failures need process isolation.

Library logs are silent by default. Register a callback through
[mutracer-log.h](include/mutracer-log.h) to receive diagnostics and optional profiling
messages. Callbacks run serially on the emitting thread; message storage is valid
only during the callback. Unregister before releasing the callback or its data.

Raw scenes support the [intersection modes above](#intersection-backend).
Topology-changing geometry updates, texture/emission material updates, device-loss recovery,
browser display parity and a stable release ABI remain pending.
The viewer provides [native OIDN controls](./viewer/README.md#controls).
The engine API covers part of the browser Engine/Render/Display API; see
[its differences](#render-with-the-engine-api).
