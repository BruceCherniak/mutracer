# Native feasibility renderer

MuTracer's experimental C interface accepts raw scene data and renders through
native machine code and wgpu, without a JavaScript engine or Node at runtime.
It supports part of MuTracer and has an unstable ABI. It has been verified on
macOS arm64 with Metal; other platforms and a performance benefit are unverified.

## Render a scene

Building requires Rust, a C compiler/Xcode Command Line Tools, project npm
dependencies and a separately installed scriptc **0.3.2**.

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
ownership rules in [mutracer-scene.h](./mutracer-scene.h).

The output directory contains `render.png`, `render.rgba32f`, `normal.rgba32f`,
`albedo.rgba32f` and `result.json`. The PNG is a Reinhard/sRGB preview. Float files
contain linear sample averages as little-endian f32 RGBA, bottom row first;
dimensions are in `result.json`. Normal guides are not renormalized after averaging.

## Keep a scene alive and read pixels

```sh
npm run native:context
```

Use [mutracer-context.h](./mutracer-context.h) for
`create → commit → render → read_pixels → destroy`. Rendering adds samples;
for example, two calls with 32 samples produce 64 accumulated samples. Readback
copies HDR, normal or albedo pixels into caller-owned memory. The context API
has no file output. The command above builds the C consumer and saves its
verified images under `.native-build/context-core/`.

Commit replaces the full scene and restarts accumulation; submit camera/material
edits in the updated descriptor. A rejected commit retains the previous scene.
Reset clears sampling while keeping the committed scene. Contexts have independent
accumulation, with at most eight contexts on one owner thread. Commits can
briefly hold old and new scene resources together. The header specifies lifetime,
thread binding, byte lengths, error behavior and remaining limits.

## Scene inputs and options

All descriptor versions support indexed triangles, generated or supplied
normals, two UV sets, shared geometry, affine transforms, perspective and
orthographic cameras, raw RGBA8 sRGB or RGBA32F linear textures, rectangular,
spherical, directional and spot lights, and emissive meshes.

Version 2 also accepts RGB vertex colors, XYZW tangents, per-vertex material
indices, per-mesh material tables, local instance transforms and RGB instance
multipliers. Empty instance batches are valid. A triangle's vertices must select
the same material; duplicate vertices at material boundaries.

Version 2 exposes all non-displacement material properties and texture slots
through [material property IDs](./mutracer-material-properties.h), including
thin film, participating media, opacity, anisotropy, coat and fuzz. Omitted
properties keep MuTracer defaults. Environment lighting and visible backgrounds
can use separate linear RGBA32F equirectangular maps. Environment/background map
roles ignore texture UV transforms and flip settings. Quality flags enable
bevel, three dispersion wavelengths, or a hidden background; a hidden background
cannot also select a background map.

Version 3 adds displacement, rectangular-light textures and spot-light IES.
Displacement uses the first material of each mesh, with UV, triplanar, spherical
or cylindrical projection, including negative amplitudes. Active displacement
requires a square power-of-two texture, UVs for UV projection and a positive
step size. Projection scale and position/UV components multiplied by that scale
must have absolute values at most 1,000,000. Displacement's cross-backend color
and normal parity remains unresolved.

IES inputs are UTF-8 LM-63 Type C files with `TILT=NONE`, at most 16 KiB per
profile. Submit source text through the light descriptor; profile preparation
runs natively. Invalid profiles return an error. Reusing an offset/length pair
shares that profile. Versions 1 and 2 keep their earlier input restrictions.
Additional examples are `v3-displacement-uv`, `v3-displacement-triplanar`,
`v3-ies`, `v3-ies-shared` and `v3-rect-texture`.

Calls block until completion, copy their inputs and retain no caller storage.
Use one owner thread for all calls. Every raw probe call rebuilds the scene and
restarts accumulation; context render calls retain the committed scene. Samples
range from 1 to 4096; seed is fixed at 12345 and bounce count at 6. Version 1 remains accepted with its original limited inputs;
unknown or unsupported fields return an error.

Build/run settings:

- `MUTRACER_NATIVE_OUTPUT`: output directory; defaults are `.native-build/scene-core/`
  for `native:scene` and `.native-build/context-core/` for `native:context`.
- `MUTRACER_NATIVE_SAMPLES`: verification samples, default 256; range 1..4096
  for scene verification, 8..4096 for context verification.
- `CARGO_TARGET_DIR`: optional reusable Cargo build directory.
- `CC`: C compiler executable, default `cc`.

## Limits

Input is limited to 64 MiB; output and total raw texture pixels to 4,194,304 each.
There must be at least one geometry, mesh and material. Counts are limited to
4096 geometries, 65536 meshes/materials/expanded instances, 64 analytic lights and
256 textures. Geometry preparation has a conservative 64 MiB budget, including
material-related expansion. Atlas storage is limited to 64 MiB, 4096 pixels per
side and 256 layers; source textures can be scaled to fit. The header specifies
the remaining validation and format constraints.

Raw scenes currently use software BVH traversal on the GPU. Incremental scene
updates, jobs/cancellation, device-loss recovery, denoising, browser display parity
and a stable release ABI remain pending. This library does not yet replace
the full browser Engine/Render API.

## Prepared replay and experimental HWRT

A separate interface replays prepared scene files:

```sh
npm run native:render
.native-build/render-host .native-build/scene .native-build/another-image 256 repeat
```

Its output defaults to `.native-build/`; `MUTRACER_NATIVE_SAMPLES` defaults to 64
for this command. Scene preparation requires Node, while the built consumer runs
without Node. [mutracer-probe.h](./mutracer-probe.h) describes camera translation,
base-color/roughness edits, seed and bounce options. Each call starts from the
prepared scene; edits do not persist or enable new material variants.

Set `mt_probe_options.flags = 4` to require experimental hybrid HWRT. Unsupported
adapters or captures return an error; flags 0 selects software traversal. HWRT
requires opaque BVH2 geometry with no displacement or shader bevel. Scenes with
nonuniform scale, reflection or shear use software closest-hit traversal and
hardware shadows because broader closest-hit parity remains unresolved.
Diagnostic overhead and software fallbacks apply; no speedup is claimed.

Output formats match the raw-scene probe. All interfaces share the owner-thread
restriction. The replay probe rebuilds
each call; contexts use the lifecycle described in their header. Contributor
build, comparison and compiler diagnostics are in
[CONTRIBUTING.md](./CONTRIBUTING.md).
