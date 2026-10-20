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
For caller-supplied data, use `mt_probe_render_scene` with the byte layout and
ownership rules in [mutracer-scene.h](include/mutracer-scene.h). Add `native/include`
to your C compiler's header search path.

The output directory contains `render.png`, `render.rgba32f`, `normal.rgba32f`,
`albedo.rgba32f` and `result.json`. The PNG is a Reinhard/sRGB preview. Float files
contain linear sample averages as little-endian f32 RGBA, bottom row first;
dimensions are in `result.json`. Normal guides are not renormalized after averaging.

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

Use [mutracer-context.h](include/mutracer-context.h) for
`create → commit → render → read_pixels → destroy`. Rendering adds samples;
for example, two calls with 32 samples produce 64 accumulated samples. Readback
copies HDR, normal or albedo pixels into caller-owned memory. The context API
has no file output. The command above builds the C consumer and saves its
verified images under `.native-build/context-core/`.

Commit replaces the full scene and restarts accumulation; submit topology,
texture, emission and light type/count/attachment edits in the updated descriptor.
A rejected commit retains the previous scene.
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

For camera edits, `mt_context_update_camera` accepts the same 128-byte `Camera[32]`
record from the scene descriptor. It retains geometry, textures and the pipeline,
uses the committed image dimensions, and restarts accumulation on every successful
call. It supports perspective/orthographic projection, transform, zoom and lens
fields. The header specifies rejection, job lifetime and thread rules. Run
`npm run native:camera` to build and verify this C usage; results are saved under
`.native-build/camera-core/`.

Use `mt_context_update_transform` to replace a mesh world matrix or a single
instance's local matrix without re-uploading vertices or textures. A mesh world
edit also moves all instances in its batch. Lighting and shadow placement follow
the new transform. Updates restart accumulation and reject active jobs. Edits
that need larger GPU resources or a deeper traversal stack require a full commit;
validation rejection preserves the scene and samples. Cost grows with instance
count, acceleration-structure data and emissive triangles. See
[the context header](include/mutracer-context.h) for the 80-byte record and lifetime rules.

Use `mt_context_update_geometry` for vertex positions with unchanged topology.
All objects sharing the original geometry change together. Supply normals or omit
them to generate smooth normals; generated tangents update automatically, while
authored tangents require replacement values. UVs, colors, indices, materials
and textures stay unchanged. Displacement, unused geometry and edits that change
GPU resource sizes or the required shader variant require a full commit. Successful
updates restart accumulation;
validation rejection preserves the scene and samples. Updates reject active jobs.
CPU copying cost can grow with the scene. GPU uploads cover changed geometry
and affected instances; HWRT rebuilds affected acceleration structures. Temporary
copies increase memory use. See
[the context header](include/mutracer-context.h) for flags, limits and record layout.

Basic material parameters can be updated with `mt_context_update_material` using
the original descriptor's material index. Color, roughness, metalness,
transmission and IOR updates retain geometry, textures and pipelines, then reset
accumulation. Unlit/unused materials and medium shader-feature changes require
a full scene commit; rejection preserves the current scene and samples. These
updates reject active jobs. See [the context header](include/mutracer-context.h) for
the record layout and lifetime rules.

Use `mt_context_update_environment` to replace linear environment/background map
pixels or a solid background color while retaining geometry, material textures
and the pipeline. Map dimensions, map presence and background visibility must
match the committed scene; changes require a full commit. Moving between zero
and nonzero map power can also require a full commit. The call restarts
accumulation, rejects active jobs and preserves the scene on validation rejection.
Its cost grows with map size and the number of emissive triangles. See
[the context header](include/mutracer-context.h) for the record format and limits.

Use `mt_context_update_light` to change an existing rectangular, spherical,
directional or spot light's color, intensity, size, spread/angles or transform.
It retains geometry, acceleration structures, material textures and the pipeline;
existing rectangular emission textures and spot IES profiles are preserved.
Light type/count and attachment changes require a full commit. Some zero/nonzero
power transitions also require a full commit. Successful updates restart
accumulation. Active jobs reject updates; validation rejection preserves the scene.
Update cost grows with the number of lights and emissive triangles. The
[context header](include/mutracer-context.h) specifies the record and lifetime rules.

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
or fail to accumulate without a reported error. This occurs with small
64-ray dispatches while other GPU users, including ordinary background apps,
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
any incremental scene update, reset, readback and destroy return errors. A full
commit can prepare alongside the active job; successful publication drains the
old job before replacing the scene. Finish or cancel and drain a job before
using the other calls. The header
specifies job states, sample counters and handle lifetimes.

## Scene inputs and options

Only scene descriptor **version 4** is accepted. It supports indexed triangles,
generated or supplied
normals, two UV sets, shared geometry, affine transforms, perspective and
orthographic cameras, raw RGBA8 sRGB or RGBA32F linear textures, rectangular,
spherical, directional and spot lights, and emissive meshes.

It also accepts RGB vertex colors, XYZW tangents, per-vertex material
indices, per-mesh material tables, local instance transforms and RGB instance
multipliers. Empty instance batches are valid. A triangle's vertices must select
the same material; duplicate vertices at material boundaries.

The descriptor exposes all non-displacement material properties and texture slots
through [material property IDs](include/mutracer-material-properties.h), including
thin film, participating media, opacity, anisotropy, coat and fuzz. Omitted
properties keep MuTracer defaults. Environment lighting and visible backgrounds
can use separate linear RGBA32F equirectangular maps. Environment/background map
roles ignore texture UV transforms and flip settings. Quality flags enable
bevel, three dispersion wavelengths, or a hidden background; a hidden background
cannot also select a background map.

It accepts displacement, rectangular-light textures and spot-light IES.
Displacement uses the first material of each mesh, with UV, triplanar, spherical
or cylindrical projection, including negative amplitudes. Active displacement
requires a square power-of-two texture, UVs for UV projection and a positive
step size. Projection scale and position/UV components multiplied by that scale
must have absolute values at most 1,000,000. Displacement's cross-backend color
and normal parity remains unresolved.

IES inputs are UTF-8 LM-63 Type C files with `TILT=NONE`, at most 16 KiB per
profile. Submit source text through the light descriptor; profile preparation
runs natively. Invalid profiles return an error. Reusing an offset/length pair
shares that profile.
Additional examples are `v3-displacement-uv`, `v3-displacement-triplanar`,
`v3-ies`, `v3-ies-shared` and `v3-rect-texture`.

Scene commits copy their inputs and retain no caller storage. Raw probes and
`mt_context_render` block until rendering finishes; jobs use the polling lifecycle
above. Keep borrowed input/output storage valid until the call returns. Every
raw probe call rebuilds the
scene and restarts accumulation; context render calls retain the committed scene.
Samples range from 1 to 4096. `mt_context_commit` defaults to Sobol, seed
12345 and six bounces. `mt_context_commit_with_settings` accepts the sampling
pattern, sequence, bounce and quality options in the context header. Unknown
or unsupported fields return an error.

Build/run settings:

- `MUTRACER_NATIVE_OUTPUT`: output directory; defaults are `.native-build/scene-core/`
  for `native:scene`, `.native-build/context-core/` for `native:context` and
  `.native-build/job-core/` for `native:jobs`; `native:camera` uses
  `.native-build/camera-core/`.
- `MUTRACER_NATIVE_SAMPLES`: verification samples, default 256; range 1..4096
  for scene verification, 8..4096 for context, job and camera verification.
- `CARGO_TARGET_DIR`: optional reusable Cargo build directory.
- `CC`: C compiler executable, default `cc`.

## Limits

Input is limited to 512 MiB; output to 4,194,304 pixels and total raw textures
to 16,777,216 pixels.
There must be at least one geometry, mesh and material. Counts are limited to
4096 geometries, 65536 meshes/materials/expanded instances, 64 analytic lights and
256 textures. Geometry preparation has a conservative 1 GiB budget, including
material-related expansion. Atlas storage is limited to 64 MiB, 4096 pixels per
side and 256 layers; source textures can be scaled to fit. The header specifies
the remaining validation and format constraints.

Every C API call returns `MT_OK` (0) or a nonzero `mt_status` from
[mutracer-status.h](include/mutracer-status.h), plus an optional message for
people. Branch on the code rather than the message: retry `MT_ERROR_BUSY`,
submit a full commit after `MT_ERROR_FULL_COMMIT_REQUIRED`, and enlarge the
destination after `MT_ERROR_BUFFER_TOO_SMALL`. Treat an unknown nonzero code as
a failure; later versions may add codes. The same header names the backend,
image kind, context/job state, sampling pattern and denoiser backend values.
When loading the library dynamically, compare `mt_abi_version()` with the
`MT_ABI_VERSION` you compiled against.

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
This library does not yet replace the full browser Engine/Render API.
