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
environment edits, Radiance HDR loading and PNG output. It also records raw
software/HWRT HDR and guide differences, asserts the actual backend, and runs native
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
Check the actual backend after every HWRT commit. Unsupported devices and AS
allocation or limit failures must report a software fallback. The first-hit and
path diagnostic tools compare authoritative hardware identities against software;
image statistics use a high-sample software reference. Do not treat a fallback
as a hardware success or native OIDN as browser-model numerical parity.

## Shared scene assembly and render settings

The raw context compiles the shared TypeScript scene assembly. Both paths use
the same attribute layout, light choices/PMFs/IES packing, stack capacity and
uniform setters. Render limits live in a platform-independent module; the browser
pipeline reexports the same constants and normalizers.

Use `native/generate-layout-schema.mjs` after editing the shared layout schema.
Its `--check` runs with typecheck. Descriptor/uniform/resource offsets and the
displacement quantization contract are generated for TS, Rust and C.

`npm run native:settings` runs scene/context/jobs/camera validation, then checks
the settings C API on ordinary, alpha, IES and displacement fixtures with both
backends. It asserts the actual backend, all three sampling patterns, finite
AOVs, default normalization, rejection preservation and exact blocking/job
accumulation. Settings behavior and defaults are in mutracer-context.h.

Production commits emit their selected shader; diagnostic variants are requested
by diagnostic tools. The AOT cache retains at most 32 generated variants and checks
the complete signature after hashing. Rust tests check the actual AOT cache reuse
and that production packets contain exactly one backend shader.

## Native storage access validation

Source kernels select pixel storage and scale once per texture. Public geometry
attributes remain caller-owned; algorithms use Uint32 index views, Float32 vertex
attributes and Float64 matrix copies. Uint16 indices acquire a cached Uint32 copy
that refreshes after topology notifications or source replacement.

`native/storage-lowering.mjs` uses the TypeScript checker to instantiate numeric
generics, including nested closures, without changing arithmetic, branches or
scale values. `attribute-lowering.mjs` then turns provably concrete accesses into
indexing. Generated `numeric-access-report.json` traces native exports through
constructors, getters and callbacks; a dispatcher reachable from a loop fails a
production build. Compatibility probes retain their open-storage diagnostics.

Run `npm run native:storage:verify` with `MUTRACER_SCRIPTC` set to scriptc0.3.2.
The C consumer compares all four pixel formats, byte/half output, subarray offsets,
resizing, orientation, environment CDF and power against the ordinary Web TS path.
Also run the lowering behavior tests, normal library checks and real Web/native
image comparisons; clean compilation alone does not validate specialization.

Native bounds and generated-tangent kernels are the profiled O(N) exceptions to
TS reuse. Their owned result packet uses the generated layout; decoding, scene
assembly and incremental updates still execute the shared TS. Tangent length
uses the compiled TS Math.hypot primitive to preserve its rounding. Run host tests
with `MUTRACER_KERNEL_FIXTURES=/absolute/manifest.json` to compare kernel packets
and every production resource byte against the TS reference on those descriptors.
`prepare-diagnostics INPUT OUTPUT BACKEND ITERATIONS` profiles CPU preparation
without creating a GPU device. `nativeDataKernelProfile.completedWallMs` includes
kernel computation and transfer; it is part of decode/hardware preparation, not
an additional phase.

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

## Module and resource diagnostics

`npm run native:check`, `npm run native:modules:verify` and
`npm run native:storage:verify` validate compiler support, concrete storage and
native module contracts. These checks remain separate from GPU output gates.

The independent raw-scene oracle records Web adapter resource writes through
`validation/resource-recorder.mjs`. It neither validates nor executes shaders;
real wgpu and browser GPU tests validate execution. Production native rendering
accepts raw descriptors only and never reads these oracle captures.

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

Run `[MODEL] --transform-smoke DIRECTORY` on software and HWRT backends. It
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
root and vertex region, rather than assuming stable instance order.


## Partial vertex validation

Run `[MODEL] --geometry-smoke DIRECTORY` to compare stable-topology deformation
with full commits on software and HWRT backends. Verify all three AOVs, generated/
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


## Native TinyBVH boundary

Raw scene commits and transform/vertex update TLAS construction use the official
TinyBVH header pinned in `native/vendor/tinybvh/`. The host compiles the browser's
existing C++ wrapper directly; preserve pointer-width-safe result addresses and
`-ffp-contract=off` for conservative float bounds. Native and Web now pin
TinyBVH 1.9.1 to the same upstream revision; all six native headers are unmodified
and recorded in the vendor manifest. See the shared
[adapter contributor guide](../src/tinybvh/CONTRIBUTING.md) for Wasm rebuilding
and CWBVH conversion.

The native bridge enables full ARM NEON/Bonsai construction and upstream workers
with aligned float4 vertices retained through serialization. Web uses its scalar
Wasm build and existing browser worker pool. Native spatial splits stay disabled,
matching the browser default; Web spatial splits remain opt-in. Upstream chooses
threaded work by size; small BVHs stay on the calling thread. Stable-topology
refits still use the original TS updater. The 1.9 process-wide worker pool
survives a host thread and joins at shutdown. Check host exit, explicit shutdown,
restart and process exit with ThreadSanitizer:

```sh
c++ -std=c++20 -O1 -g -fsanitize=thread -ffp-contract=off \
  -I native/vendor/tinybvh native/host/tinybvh.cpp \
  native/tests/tinybvh-thread-exit.cpp -o /tmp/mutracer-tinybvh-thread-exit
TSAN_OPTIONS=halt_on_error=1 /tmp/mutracer-tinybvh-thread-exit
```

The synchronous AOT steps return geometry/displacement/AABB jobs, retain source
state across arena resets, and consume the host's BVH2 results. Shared TS code
packs instance records, materials, lights and shader resources. Stable-topology
BLAS refit still reuses `updatePreparedGeometries`; the TS SAH builder remains
available to browser/replay fixtures and legacy stateless AOT comparison exports.

Compare native and Wasm on identical inputs, including degenerate triangles and
all displacement projections. SIMD/Bonsai and scalar builds can choose different
trees: validate primitive identity, conservative bounds and GPU output, and keep
byte comparisons for matching builder configurations. Full and partial
results must agree on HDR/normal/albedo, survive failed candidates/other contexts,
and preserve HWRT identity mapping after TLAS leaf reordering. Compare against
the chosen builder reference: switching from built-in SAH to TinyBVH can change
leaf order, packed displacement heights and output. Archive those differences;
do not silently change the rendering algorithm or claim universal pixel parity.
The native TinyBVH license belongs under `native/LICENSES/` and is also copied
into the application bundle.

## Performance comparisons

Set `MUTRACER_NATIVE_PROFILE=1` for one JSON diagnostic per successful full
context commit. CPU preparation and HWRT capture are separate from GPU setup.
GPU setup includes uploads, acceleration structures, bindings and validation;
pipeline creation is a subset of it, not an additional phase. An upload retry
also includes fallback preparation in setup; check `uploadRetried`. Timings
exclude replacing/dropping the previously committed scene.

The accompanying `nativePreparationProfile` splits validation, source decoding,
native BLAS construction, mesh assembly, native TLAS construction and resource
composition. AOT phase times include output copying and collection. Source
decoding includes missing-attribute generation and BLAS job serialization; mesh
assembly includes consuming BLAS results and packing the TLAS request. Keep
authored normals in the initial Geometry options so its shared constructor does
not generate normals that the decoder immediately replaces.

Compare identical raw inputs, seeds, samples and batch sizes against the browser
TinyBVH backend. Drain GPU work before stopping render timers, measure first and
warm runs separately, and read images outside render timing. Keep shader caches
and adapter differences explicit. Browser JS heap and native process peak RSS
are different memory metrics and must not be reported as a memory speedup.

Closed native vector calls use `vector-lowering.mjs` to clone the shared AST with
concrete Float32/Float64 parameter storage before direct-access lowering. Mixed
precision and aliasing retain the source arithmetic/order; open unions, ordinary
arrays and callbacks keep the generic implementation. Do not assume every call
is concrete. Run `node native/vector-verify.mjs` and `node native/matrix-verify.mjs`
with the pinned compiler before comparing full/partial GPU outputs. Their C
consumers compare against upstream gl-matrix, including shared storage aliases,
zero vectors and the generic fallback. Performance runs must alternate old/new
order and keep unrelated builds/GPU work out of the timed interval.

## Reproducible descriptor benchmarks

```sh
node native/benchmark/benchmark.mjs --manifest /absolute/inputs.json \
  --library /absolute/libmutracer_native_probe.dylib --output /absolute/evidence --port 4201
```

Open the printed loopback URL. Use `?index=0&edits=1` for transform and vertex
edits, restoring the original value between observations. Both hosts select the
first source mesh using the largest geometry and edit its middle vertex.
`benchmark-native.py --single` makes one commit and one 64spp render for image
validation instead of collecting repeated wall-time samples.

Each manifest entry has a unique `key`, an `input` descriptor path relative to
the manifest, its `sha256`, and `expectedHardware: {active, reason}`. Determine
the expected path independently; every native commit asserts it. Descriptors
include dimensions and camera. Models and results stay outside the repository.
The tool snapshots its library and clients, records source/bundle hashes, and
uses 64spp, seed 12345, six bounces, eight samples per batch, TinyBVH BVH2 and
eight Web Workers.

The browser drives three serial rounds in forward/reverse/forward backend order.
Each group warms first and records twelve full commits and twelve 64spp renders;
exclude the first two observations. Retain the median, range and per-round
values of all thirty remaining samples. The device and Worker pool persist
within a group; navigation separates groups. Resume interrupted runs with
`?index=N`, keeping incomplete attempts separate.

Web commits wait for deferred packing, pipeline readiness and upload completion.
Readback and legacy HWRT counters stay outside render timers. Native commit
wall time includes retiring the previous scene; `nativeCommitProfile.totalMs`
ends before the final queued-upload flush, publication and retirement. Native
peak RSS and browser JavaScript heap are distinct memory metrics. Report actual software fallbacks separately.

`MUTRACER_NATIVE_PROFILE=1` records CPU phases and application upload bytes.
`MUTRACER_NATIVE_GPU_TIMESTAMPS=1` additionally requests optional timestamp features
for blocking-render kernels and full-commit AS builds. Its allocations and
synchronization affect wall time, so collect this breakdown separately.
The pinned Metal backend exposes pass timestamps but not encoder timestamps:
AS GPU time remains unavailable. `completedWallMs` starts after prior uploads
have drained and ends when the AS build completes. Zero or unordered timestamp
samples are rejected. Upload totals include application writes and explicit
hardware input buffers; driver-internal AS instance traffic is unobservable.
The native edit helper reports rejected partial updates explicitly.

## Native library OIDN validation

`host/src/denoise.rs` owns the same SDK adapter used by the viewer worker and
`mutracer-denoise.h`; do not duplicate filters or guide/alpha semantics. The C
handle registry is independent of the AOT owner, local to its creating thread,
and uses non-recycled IDs. Check stale/wrong-thread rejection, independent worker
handles, resizing, malformed image lengths/pointers/nonfinite values, output
rollback and in-place output. SDK calls and library loading occur only on use.

Compile the no-Node consumer against the built library:

```sh
cc -Wall -Wextra -Werror native/denoise-host.c -L "$CARGO_TARGET_DIR/release" \
  -lmutracer_native_probe -Wl,-rpath,"$CARGO_TARGET_DIR/release" -o denoise-host
./denoise-host /absolute/libOpenImageDenoise.2.dylib INPUT_DIR OUTPUT.rgba32f 480 320
```

For a C consumer linked to the native static library on macOS:

```sh
cc native/denoise-host.c "$CARGO_TARGET_DIR/release/libmutracer_native_probe.a" \
  -framework Foundation -framework Metal -framework QuartzCore \
  -framework Security -framework CoreGraphics -lc++ -liconv -o denoise-static
```

Use regular/small-only bundled runtime, check explicit CPU/Metal and Auto, preserve
raw context output, and compare both quality and alpha to retained reference
images. Relocate the package, inspect the component license tree and validate its
signature after changing bundle resources. No render performance conclusion may
include this optional SDK loading/inference inside a tracing timer.

## Robustness and diagnostics

Caught TypeScript exceptions must retain their operation code and message across
the packet boundary. Exercise the actual AOT archive; a JavaScript-only test is
insufficient. Fatal AOT traps abort the process, so fuzz in a separate process.

With nightly Rust and cargo-fuzz installed, set `MUTRACER_AOT_ARCHIVE` to the
compiled archive and `CARGO_TARGET_DIR` to an evidence directory outside the
checkout. Generate a valid seed with `cargo run --manifest-path
native/host/Cargo.toml --features fuzzing --bin fuzz-seed -- SEED_PATH`. Put that
seed and small descriptor fixtures in external corpus directories. Run each
target for at least 30 minutes:

```sh
cargo +nightly fuzz run --fuzz-dir native/host/fuzz validate CORPUS_VALIDATE -- \
  -max_total_time=1860 -max_len=65536 -artifact_prefix=ARTIFACT_DIRECTORY/
cargo +nightly fuzz run --fuzz-dir native/host/fuzz commit CORPUS_COMMIT -- \
  -max_total_time=1860 -max_len=65536 -artifact_prefix=ARTIFACT_DIRECTORY/
```

The commit target needs a real adapter and checks both actual backends with
bounded dimensions, geometry and displacement work. Rust AddressSanitizer does
not instrument the scriptc archive or system drivers; report instrumentation
boundaries. Compile C++ separately with a compatible sanitizer runtime before
claiming C++ coverage. Preserve failing inputs, logs, exact toolchain and hashes.

Library diagnostics use `mutracer-log.h`; standalone Rust tools explicitly enable
stderr logging. Missing or invalid GPU timestamps produce a diagnostic and a
missing measurement, while rendering continues. Upload payload counts belong at
the actual write calls; buffer capacity and required AS storage are separate.

## HWRT reproduction

Run the small interleaved geometry/full-commit diagnostic with the linked AOT archive:

```sh
cargo test --manifest-path native/host/Cargo.toml --lib \
  changed_blas_and_tlas_are_ready_after_interleaved_retained_edits -- --nocapture
```

It prints AOV and primary-hit coverage classifications; a mismatch is reported
separately from the other task checks while the known Metal HWRT bug is open.
Independent-process stop-at-first-mismatch runs observed process 8 on Phase 2
(`09ba6ce`) and process 20 on Phase 3.1 (`d334f37`). The Phase 1 closest
geometry-only equivalent observed process 13; its padded transform packet was
rejected before rendering, so it starts with the same final transform. These
stopping times do not estimate a failure rate or identify every mismatching
sample's root cause. Phase 3 acceptance still requires the repair gate.
