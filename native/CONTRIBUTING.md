# Native contributor guide

The native implementation is an experimental synchronous AOT core plus Rust/wgpu
host. Usage and supported inputs are in [README.md](./README.md). Do not treat
module compilation, prepared replay and raw-scene rendering as equivalent gates. License
texts and notices belong to their component: [native library](./THIRD_PARTY_NOTICES.md)
and [native viewer](./viewer/THIRD_PARTY_NOTICES.md). Shared renderer notices stay at
the repository root.

## Native viewer validation

`npm run native:viewer:build` checks the complete AOT entry graph, builds the
archive and Rust viewer with locked dependencies, creates a macOS app bundle
and ad-hoc-signs it. `native:viewer` also launches it. The viewer is a small
client of the experimental ABI; backend selection extends the C entry points
without changing existing signatures or structure layouts. Its owner-bound
wrapper cannot be sent to another thread. UI presentation uses egui/glow; tracing uses the existing wgpu/Metal
library and reads completed HDR batches back to the UI.

Run the bundled executable with `[MODEL] --smoke-out DIRECTORY` for real GPU
checks of load/render, queued cancellation/restart, orbit/restore, material and
environment edits, Radiance HDR loading and PNG output. It also compares raw
software/automatic HWRT HDR and guides, records query counts, and runs native
OIDN against a higher-sample reference without changing accumulation. Test both
external and embedded textured GLTF resources, unsupported required extensions and malformed
files. Copy the app elsewhere and run with an empty inherited environment and
`PATH=/nonexistent`; compare HDR bytes and inspect native dependencies. Keep
fixture generation, images, detailed checks and measurements outside the repo.

Run `cargo test --locked --manifest-path native/viewer/Cargo.toml` with
`MUTRACER_AOT_ARCHIVE` set to the built archive. Input tests cover stationary and
outside presses, and orbit/Shift/right-pan gestures delivered across frames or
coalesced into one frame. Keep event ordering: release-frame movement must not
be dropped, and moving the pointer to press must not move the camera.

Also inspect the actual app: open a file, change each panel, orbit/pan/zoom/fit,
pause/resume/restart, change resolution and exposure, and export PNG. Headless
smoke alone does not validate window input or file dialogs. Record any OS lock
or permission block without marking the interactive gate complete. The supplied
procedural GLB is original project geometry under the repository MIT license.
The build rebuilds OIDN2.5.1 core/API without the three large weight blobs and
bundles the ABI-matched official CPU/Metal modules and upstream license notices. `MUTRACER_OIDN_ROOT` can select an extracted SDK; direct Cargo executable
runs can set `MUTRACER_OIDN_LIBRARY` to its main dynamic library. The package helper
copies and signs libraries atomically so rebuilding does not truncate loaded code.

Run the executable with `--interaction-smoke DIRECTORY` to hold continuous camera
input, assert changing/nonblank previews, reject stale OIDN output after a resize,
and wait for the new denoised result. Keep AOT/context calls on the UI owner thread;
the OIDN worker owns only its separate OIDN device/filter and copied image data.
Set `MUTRACER_NATIVE_VALIDATE_SHADOWS=1` before raw HWRT scene commit to compare
hardware shadow results against software per ray; counter 9 must remain zero.
Also check forced-HWRT rejection preserves the prior scene, and automatic fallback
reports alpha/version-3/bevel/empty-scene exclusions. Do not treat a fallback as a
hardware closest-hit success or native OIDN as browser-model numerical parity.

## Partial camera validation

`npm run native:camera` runs the complete job gate, then compares partial camera
updates against full scene commits for six camera records on each of 33 fixtures.
The cases cover translation, perspective field/clip/zoom changes, physical lens
changes, orthographic projection, affine shear and restoration. It tests input
ownership, zeroed accumulation, invalid descriptor preservation, active-job
rejection, completed-job expiry and owner/stale-handle rejection. HDR and both
guides must match exactly; restoration must reproduce the original image.

`camera-core.ts` only decodes the wire camera record into the existing TS
`Camera`, lens/math and uniform-packing functions. Both `scene-core.ts` and the
partial AOT export call that same adapter. Rust shares the full-scene lens/
transform validator, copies the AOT command before arena reset/collection, checks
finite packed values, uploads the camera uniform and clears accumulation. It
does not rebuild the scene, bind groups, textures or pipeline. No duplicate
camera math is implemented in Rust. Material and environment updates retain
separate preparation state as described below; geometry updates remain pending.

## Job validation

`npm run native:jobs` first runs `native:context`, then exercises queued,
running, cancelling, cancelled and completed states on every raw fixture. It
checks busy-context rejection, owner binding, stale handles, cancellation before
and after dispatch, completed-sample accounting and two interleaved jobs with
different batch sizes. Cancelled accumulation resumes and must match the blocking
reference in HDR, normal and albedo bytes. `job-verification.json` is complete
only after every fixture passes. Check counts include timing-dependent poll loops.

Submission creates a job without dispatch. Owner-thread polls use wgpu's
non-waiting poll mode, observe an atomic completion flag, and submit at most one
bounded batch. Queue callbacks only set their owned atomic flag; they never
reenter AOT or access the registry. Cancellation drains submitted work before
releasing the context. A failed scene can be replaced or destroyed even with an
old completion outstanding; that callback cannot revive a handle. No background
worker is introduced. Keep no-Node execution and previous-stage byte comparisons
outside the repository; repeat legacy software/HWRT replay after dispatch changes.
Forced GPU failure and device-loss recovery remain unvalidated.

## Persistent context validation

`npm run native:context` first runs the full raw-scene compilation/preparation
and one-shot rendering gate, then exercises the persistent C API for every
fixture. `GpuScene` owns upload/pass resources; both the old probe and context
API use that same implementation. Contexts retain their native device across
commits. A candidate upload is checked in validation/OOM scopes before replacing
the committed scene. No AOT arena pointer or caller input survives the call.

The C consumer compares split accumulation, reset/replay and normal/albedo/HDR
readback with the one-shot output; interleaves two contexts, commits camera
edits, rejects malformed commits without replacing old outputs, checks short
buffers, stale handles, and wrong-thread calls through both context and probe
entries. Context handles are monotonic; owner binding persists after teardown
because the AOT module is process-global. ABI entries catch Rust panics while
mutex guards stay in scope, so the registry/entry mutex is not poisoned. GPU
execution errors mark the affected scene failed. Hardware device-loss recovery is pending.

The command writes `context-verification.json`. It reuses the raw preview only
after the context's HDR bytes match exactly. Keep cross-stage HDR comparisons,
no-Node process runs, legacy replay/HWRT regressions and timing evidence outside
the repository. Compilation/module and browser parity limitations below remain
separate from successful context lifecycle validation.

## Raw-scene validation

`npm run native:scene` builds the complete composed AOT archive and native C
consumer, renders 33 fixtures, and checks native preparation against ordinary
JavaScript and independent browser-facade preparation. Each of 75 supported
material extension IDs also has an independent preparation comparison. Fixtures
cover v1 compatibility, environment/background roles, material variants, vertex
attributes, differing material tables on shared geometry, colored batches and
zero-instance batches, four displacement projections/negative/byte/zero cases,
IES source parsing/shared profiles and rectangular light textures. The module
matrix now includes full displacement and IES graphs; C verification also tests
invalid profiles and dense displacement bounds. GPU references are a separate
check; preparation equality alone does not prove GPU output equality.

Run `cargo test --locked --manifest-path native/host/Cargo.toml` with
`MUTRACER_AOT_ARCHIVE` pointing to the built archive. Descriptor tests exercise
lengths, spans, references, numeric values, material types, batch transforms and
empty/ordinary batch behavior. Run the root contributor checks for shared changes.

The material wire IDs in `material-properties.json` are frozen. Changing source
schema order must not renumber them. After deliberate schema changes, regenerate
with `node native/generate-material-properties.mjs`; the scene driver runs
`--check` and refuses stale generated TS, Rust or C files. Displacement IDs
require descriptor v3; v1/v2 retain strict validation.

Optional vertex material IDs are local to each mesh's material table. Shared
geometry is cloned when those tables require different global IDs. Geometry
expansion and total expanded instance counts are included in boundary budgets.
IES parsing exceptions return a rejected-preparation packet; Rust copies it and
resets/collects AOT storage before returning an error. Rust validates byte spans,
UTF-8 and budgets, while the original TS parser validates photometric syntax.
Active displacement validates square/power-of-two sources, UV availability,
positive step size and coordinate/projection limits before AOT loops.
The empty-batch path pads storage allocations to the shared browser minimum.

For GPU comparisons, start `native/reference-server.mjs` with
`MUTRACER_NATIVE_OUTPUT` set to the scene output directory and
`MUTRACER_REFERENCE_SCENES=1`. Open `/v2-environment/?samples=256` or another
fixture path. Outputs go to `<fixture>/reference/browser-reference/`. Compare
HDR and guides with `native/compare-hdr.mjs`; record errors and tolerances rather
than declaring a universal driver tolerance. Close temporary tabs and stop the
server afterward. Keep experiment logs and per-image metrics outside the repo.

## Prepared replay: verify modules, then compose

```sh
export MUTRACER_SCRIPTC=/absolute/path/to/node_modules/.bin/scriptc
npm run native:modules
```

This attempts native builds of fifteen module graphs. Fourteen shared computation
graphs compile, including geometry updates, material/texture preparation, atlas
layout and pixels, and scene-light processing. The browser material table still
depends on Canvas and GPU resources and remains blocked.
`modules/summary.json` records the results, including errors in uncalled exports.
The command exits **1** while any module is blocked.

To execute the compiled modules through standalone C consumers:

```sh
npm run build:lib
npm run native:modules:verify
```

`native/tests/modules/` contains compilation and result-comparison fixtures that
call the implementations in `src/`. The runtime BVH and sampling byte adapters
live beside `render-core.ts` as `bvh-core.ts` and `sampling-core.ts`; verification
also exercises them. These entries do not define the final native library API.

The consumers compare native outputs with JavaScript, including repeated calls
and result-memory reset. `modules/runtime.json` records completion and failures;
the command exits 1 if any case fails. WGSL outputs are shader bodies and need
scene constants before device validation. Module verification does not provide
a native scene-creation API.

Use `native:render` and `native:verify` to check the prepared rendering
independently. The default replay uses prepared scene data and shaders. Math,
geometry/updates, Camera, environment distribution, BVH facade, material/atlas data,
lights and shader generation are verified independently of that replay.
Eligible builtin BVH2 BLASes are rebuilt from raw
indexed geometry at runtime. Initial scene, TLAS, instance/material data and
shader specialization remain prepared inputs. `native:verify` removes the
prebuilt combined BVH file and requires the same C-driven render/AOV output.


## What executes where in the prepared replay

| Part | Current execution |
| --- | --- |
| Initial scene/raw geometry, TLAS/instances, materials/lights, camera | JavaScript at build time; independently compiled geometry and Camera are not yet wired into native scene creation |
| Numeric math | Vendored gl-matrix implementations with static array narrowing; compiled and independently verified |
| Eligible builtin BVH2 BLAS construction/layout | Original entire SAH/layout TypeScript module in AOT; native bounds and GPU packing |
| Sobol runtime parameter and all sampling constants | Original sampling TypeScript module in AOT; runtime selection currently Sobol only |
| WGSL generation | JavaScript at build time in default replay; independently compiled native generator matches original source output |
| Environment importance distribution | Independently compiled and verified; default replay uses prepared input |
| Material/texture/atlas data and light processing | Shared TypeScript compiled and independently verified; default replay prepares these inputs with JavaScript |
| Frame parameter packing and original `normalizeBounces` | scriptc AOT machine code, invoked for every sample |
| Camera translation/shared camera packing and material patches | scriptc AOT machine code from runtime C inputs |
| Resource creation, dispatch, accumulation, HDR readback | Native Rust/wgpu with the real GPU |
| Preview encoding | Native Rust; simplified presentation, not browser display parity |
| Hardware ray queries | Independent BLAS/TLAS probe and opt-in hybrid MuTracer rendering pass |

Verified on Apple M4 Max / Metal at 480x320 and 256 samples. The actual adapter
reports `EXPERIMENTAL_RAY_QUERY` support. Real execution also passes: one BLAS,
three TLAS instances and eight analytic rays verify nearest hit, transforms,
masks, tmax, back-face intersection and misses, including distance, barycentrics
and instance identity. The two hybrid fixtures have byte-identical
normal/albedo guides, zero shadow-decision differences and at most 3 ULP color
difference. Broader scene and feature parity remain pending.

## Deferred items and workarounds

| Item | Evidence / current workaround | Completion condition |
| --- | --- | --- |
| Reachable async in scriptc library mode | SC4005; use synchronous core calls with native orchestration | Native lifecycle/job API validated |
| Outbound FFI in library mode | `--lib --ffi` rejected by installed 0.3.2; host calls AOT and copies returned commands | Extend returned command/data protocol as needed |
| Whole entry/package lowering | Fourteen shared graphs and the raw-scene composition compile; browser MaterialTable and complete Engine/Render remain blocked | Public-export and feature equivalents validated |
| Native scene preparation | Raw descriptors now build BLAS/TLAS, attributes, materials/atlas, lights, camera and full WGSL natively; descriptor coverage is limited as listed above | Remaining scene/material features and persistent updates |
| Complete public API | Engine/Render facade, Three.js/Canvas equivalents and other runtime exports pending | Public-export/feature parity matrix completed |
| Denoising and display parity | First image is raw path tracing with a simple native preview | OIDN/JNLM and native display pipeline compared |
| HWRT coverage | Prepared replay has opaque closest-hit and shadows; affine scenes retain software closest-hit due unresolved guide differences | Affine closest-hit parity, broader scenes, alpha/displacement/bevel and performance evaluation |
| Correctness across backends | Browser/native HDR and exact guide comparisons; two native hybrid fixtures pass documented color/guide/shadow gates | Broader fixed-seed scenes and browser WebGL coverage |
| Native release | macOS-only probe and experimental ABI | Stable ABI, platform CI, release dependency/license inventory |

## Full-library diagnostics

```sh
npm run native:check
```

This inventories both published entries, analyzes all export scopes with real
DOM/WebGPU declarations, and attempts public/direct Engine/Render library
builds. It intentionally exits **1** while complete native support is unavailable.
Read `summary.json`, individual JSON diagnostics and build logs in the output
directory. Error-site counts include cascading errors, not independent fixes.
Coverage's top-level `success` can be true while uncalled exports still contain
errors; the gate counts those errors too.

## Implementation notes

`scene-core.ts` returns one synchronous resource batch. The Rust boundary checks
lengths, references, finite values, transforms and budgets before calling AOT,
and copies the returned bytes before resetting the result arena. The host owns
GPU resources and dispatch. Scene assembly, geometry merging/normals, analytic
uniforms, material feature decisions and complete WGSL source generation are
shared with browser adapters. The raw-scene ABI is a distinct experimental
entry; the replay ABI and its traversal fallbacks remain available.

`MaterialState`, `TextureState`, `MeshState` and light state hold shared data.
Browser facades retain DOM images and the public texture types. `MaterialData`
prepares material rows and atlas plans; browser code performs Canvas composition
and GPU uploads. Raw atlas pixels use the same writer in both environments.
The native light entry includes model constructor values because scriptc needs
them to lower class-typed sampler parameters. This is a complete shared light
graph, not the unchanged browser Scene API.

scriptc 0.3.2 rejects WeakMap class fields; the emissive cache keeps equivalent
weak ownership in a module registry. Native record widening can copy identity or
tuple storage, so the environment cache preserves its input generic and tuple
edits narrow their storage before mutation. Native fixtures check cache hits,
cached versus rebuilt emissive data, and repeated calls. Arbitrary `unknown[]`
class state, browser resources and reachable async remain outside this core.

`capture-device.mjs` is an offline descriptor/resource recorder, not a GPU
implementation. It does not validate or execute shaders. `prepare-scene.mjs`
uses the existing ray-tracing pass to generate a fixed initial resource state;
Rust/wgpu validates and executes the actual WGSL and bind-group layouts.
Only the capture's current formats/bindings are implemented; unsupported
operations must be recorded as limitations instead of silently ignored.
`prepare-hwrt.mjs` preserves actual TLAS leaf-order IDs and BVH triangle-record
identities while deduplicating hardware BLAS geometry. The native shader wrapper
uses the same identifier mapping as the library build; generated WGSL and GLSL
match the original source outputs. If hardware capture fails, the reason is recorded and software capture
still completes. Selecting hardware explicitly then reports that limitation.

`render-core.ts` imports the original depth-normalization function and returns
a 16-byte frame command. The host copies result-arena bytes before reset/collect.
The shared `src/renderer/cameraUniform.ts` packer runs in both the browser renderer
and AOT camera-translation command. Regression tests compare its byte layout with
the original packing and translated matrices. The native baseline's HDR hash is
unchanged by extraction. These replay edits still start from captured inputs;
the raw-scene entry prepares its scene separately.

`native/bvh-core.ts` transports both original SAH construction and BVH2 layout
outputs without replacing their algorithms. The native host computes bounds from
raw indexed vertices and writes the existing GPU layout. It verifies captured
byte sizes/depth; the integration verifier compares every reconstructed byte.
Only finite, nonempty builtin BVH2 geometry without displacement is enabled for
this initial path. Other captures retain their original prebuilt buffer.
`native/sampling-core.ts` compiles the existing sampling module; Sobol parameters
and constants are checked independently before composition. The C ABI and
existing hardware traversal fallbacks are unchanged.

`full-library.ts` and the Engine probes preserve the original implementations.
`browser-types.d.ts` supplies real types only. Library-source changes narrow
OIDN string/URL coercion and extract camera packing without changing its layout.

The internal math functions are vendored from gl-matrix 3.4.4 with MIT attribution
and original numeric operation order. Runtime code has no gl-matrix import; the
package remains a devDependency for independent comparison tests and examples.
Creators always use Float32Array, and explicit storage narrowing also supports
ordinary arrays and Float64 scratch storage. Geometry keeps supplied attribute
objects/arrays by identity, including union-typed Uint16/Uint32 index attributes.

The viewer importer expands Meshopt, quantized float attributes and WebP before
gltf-rs validation; instance transforms and the initial skin/morph pose are
applied in the scene adapter. `--inspect` prepares and renders 16 samples at
160×106; `--preview-out DIRECTORY` also saves a PNG. Run it against external
local models for compatibility checks; do not add those assets to the repository.
`--interaction-smoke DIRECTORY` includes native dropped-file events, retained
previews and invalid-drop recovery. Model decoding runs off the renderer owner
thread; native scene commits still run on the owner thread.

## Partial material validation

`[MODEL] --material-smoke DIRECTORY` compares basic material changes with full
commits, including exact HDR/normal/albedo, invalid-input and active-job rejection
and restoration. `--interaction-smoke` also combines held material edits with
camera input and compares the final accumulation to a full commit.
The native context owns an opaque AOT preparation token; retained TS MaterialData
reuses the existing repack/layout. Release tokens when candidates fail or scenes
are replaced/destroyed, and collect only after copying result bytes.
Initialize the scriptc module once: calling its init export again reinitializes
module globals and erases other contexts' rooted preparation state.

`viewer-oidn-core.mjs` pins OIDN source and weight commits, verifies source/hash
metadata, excludes the three `_large` blobs and inspects built symbols. It needs
CMake and the system make/compiler; SDK device modules avoid ISPC/TBB build
dependencies. Rebuilt core/API and official modules must be from the same version.
Check both Metal and forced CPU inference after any upstream change, compare
RGBA32F against prior output, and test a relocated package with no build-tree
loader paths. No source SDKs, weights or binaries enter the repository.

## Partial environment validation

Run `[MODEL] --environment-smoke DIRECTORY` for exact full/partial comparisons of
studio and HDR intensity/tint/rotation, including zero power, invalid/busy calls,
shape/feature rejection and restoration. `--interaction-smoke` combines held
environment/material edits with camera movement, checks no full commit occurs,
and validates the background-feature fallback with a retained preview.
Full and partial preparation call the same native adapter around the original
TS environment distribution, alias-table, emissive and analytic light packing.
Environment updates use retained material/light/emissive/uniform state without
retaining standalone environment images. Texture shape changes use full commit.
Both light-selection PMFs and the environment CDF must update with radiance.
The native OIDN CPU/Metal smoke supersedes the removed URL-only AOT/C example;
whole-entry diagnostics still include `src/oidn.ts` and its public export inventory.

## Partial analytic light validation

Run `[MODEL] --light-smoke DIRECTORY` to compare key-light color/intensity/direction
with full commits while interleaving environment changes and mapped/solid
backgrounds. Check exact HDR/normal/albedo, reset, invalid/busy/type rejection and
light removal. `--interaction-smoke` combines held light/environment/material
updates with camera movement and asserts no full scene commit during that input.
The C update also supports rectangular/spherical/spot lights with preserved
texture/IES attachments; validate those against raw descriptor full commits.

Lighting preparation stages a TS candidate. Only acknowledge it after validating
all returned resource shapes and completing GPU writes/reset. Environment power,
light records and RT uniform state must represent the last successful update;
rejected environment/light changes must not contaminate subsequent partial edits.
Light-only updates reuse original light sampling and packing through nativeLighting;
the scene also roots mesh bindings and BLASes for transform updates.

## Partial transform validation

Run `[MODEL] --transform-smoke DIRECTORY` on software and Auto backends. It
compares HDR/normal/albedo with full commits, including rotation, uniform and
nonuniform scale, reflection, invalid edits and interleaved environments.
`--interaction-smoke` also combines held transforms with camera/material/light/
environment edits, requires retained previews and no full commit in that loop.
The C record can also update a batch parent or an individual local instance.

Retain source meshes, prepared instance bindings and original BLASes. Candidate
mesh objects reuse `updateMeshInstanceTransforms`, `buildTLAS` and
`EmissiveTriangleCache`; merged vertex arrays are not rooted. Validate resource
sizes, stack bounds and packed floats before GPU writes, then accept the candidate.
Hardware updates reuse BLASes/TLAS bindings and rebuild the TLAS in place. Map
software leaf-order changes back to hardware geometry/triangle bases using BLAS
root and vertex region, rather than assuming stable instance order. A change to
the compiled hardware closest-hit eligibility requests a full commit.


## Partial vertex validation

Run `[MODEL] --geometry-smoke DIRECTORY` to compare stable-topology deformation
with full commits on software and Auto backends. Verify all three AOVs, generated/
supplied normals, authored/generated tangents, retained environments, rejection
and sample reset. Raw C cases also cover shared geometry/material-table regions,
colored batches, emissive triangles and explicit displacement fallback.

The adapter stages a copied source geometry/BLAS and transient shared
`prepareSceneMeshes` result, then calls `updatePreparedGeometries` and repacks
vertices with `packVertexAttributes`. Unchanged BLASes and material maps are
reused. Only accept the staged mesh/binding/source-geometry state after validated
GPU upload/reset. Hardware stages replacement acceleration structures and group0
against the existing pipeline, with all old resources retained until acceptance.
Transform and vertex candidates must both use the latest accepted source state.

Keep bound-array storage shared when updating Map-indexed generic binding records:
scriptc can return record copies, so replacing a tuple field does not necessarily
reach the preparation owner. The concrete MeshState/TLAS module fixtures exercise
that behavior in addition to the original structural geometry-update fixtures.
