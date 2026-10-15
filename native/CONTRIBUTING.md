# Native contributor guide

The native implementation is an experimental synchronous AOT core plus Rust/wgpu
host. Usage and supported inputs are in [README.md](./README.md). Do not treat
module compilation, prepared replay and raw-scene rendering as equivalent gates.

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

`native/modules/` contains byte adapters and deterministic fixtures that call
the implementations in `src/`. The replay also reuses the BVH/sampling adapters.
These entries are experimental and do not define the final native library API.

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
| OIDN URL utilities | Separate AOT archive verified below; not denoising |
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

## Full-library diagnostics and isolated URL archive

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

The OIDN URL archive can be checked against the JavaScript distribution:

```sh
npm run build:lib
npm run native:verify-oidn
```

Run `native:check` first and use the same output directory. Verification covers
37 cases / 3,700 calls and one invalid-model panic. No inference is executed.

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

`native/modules/bvh.ts` transports both original SAH construction and BVH2 layout
outputs without replacing their algorithms. The native host computes bounds from
raw indexed vertices and writes the existing GPU layout. It verifies captured
byte sizes/depth; the integration verifier compares every reconstructed byte.
Only finite, nonempty builtin BVH2 geometry without displacement is enabled for
this initial path. Other captures retain their original prebuilt buffer.
`native/modules/sampling.ts` compiles the existing sampling module; Sobol parameters
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
