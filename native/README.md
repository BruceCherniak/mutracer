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
`mt_engine_update` commits them to every render. Edits that a context applies
incrementally ([Editing a scene](#editing-a-scene)) finish during the call. Full
preparation runs on a library thread while the previous image stays readable
and presentable, and the render reports `MT_RENDER_PREPARING` until it is
published. The engine replaces each render's width, height, bevel and
dispersion quality bits and, when set, the camera record of the descriptor.

Render options default to the browser library's values (2048 samples, 3
bounces, 4 light candidates, bevel, 3 dispersion wavelengths); context
settings keep their own defaults. Images are top row first. Use an engine and
its objects from one thread at a time; only `mt_render_cancel` may be called
from another thread. Callbacks run synchronously inside the calls that produce
them. The header documents every option, default, error and lifetime.

Differences from the browser library:

- Every render prepares and holds its own copy of the scene, and changing a
  render's size, sampling pattern or bevel samples prepares it again. Adaptive
  resolution is therefore unavailable, and a render loop has no preview render
  unless you request one.
- Converge blocks its thread. The host drives the loop with
  `mt_render_loop_tick` instead of start and stop.
- Denoising uses OIDN only. Tiles, alpha blend strategies, adaptive sampling,
  vignette, bloom, shadow catchers, depth readback and device-loss events are
  not available.

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
