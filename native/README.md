# Native feasibility renderer

This experiment can render the existing MuTracer path-tracing WGSL on a real
native GPU through a C-callable library. It is **not** a native build of the
entire MuTracer API. It currently accepts prepared scene inputs and exposes an
experimental blocking C ABI.

## Verify modules, then compose

```sh
export MUTRACER_SCRIPTC=/absolute/path/to/node_modules/.bin/scriptc
npm run native:modules
```

This attempts native builds of thirteen module graphs. Twelve shared computation
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

Use native:render and native:verify below to check the existing rendering
independently. The default replay uses prepared scene data and shaders. Math,
geometry/updates, Camera, environment distribution, BVH facade, material/atlas data,
lights and shader generation are verified independently of that replay.
Eligible builtin BVH2 BLASes are rebuilt from raw
indexed geometry at runtime. Initial scene, TLAS, instance/material data and
shader specialization remain prepared inputs. `native:verify` removes the
prebuilt combined BVH file and requires the same C-driven render/AOV output.

## Render an image

Requirements: macOS/Metal, Rust, a C compiler/Xcode Command Line Tools, project
npm dependencies, and scriptc **0.3.2** installed separately. Node is used for
build preparation only. wgpu **30.0.1** is pinned by Cargo.lock.

```sh
export MUTRACER_SCRIPTC=/absolute/path/to/node_modules/.bin/scriptc
npm run native:render
```

All steps run serially: build the JavaScript library, prepare a procedural scene,
build the composed AOT BVH/sampling/frame/camera archive, build Rust/wgpu, link a C consumer, then
render twice inside that C process. The consumer also checks a recoverable
invalid-argument error and verifies matching HDR hashes across the two renders.

Output defaults to `.native-build/`:

- `image/render.png`: top-left origin, Reinhard + sRGB preview.
- `image/render.rgba32f`: linear sample average, little-endian f32 RGBA,
  **bottom row first**, no header. Dimensions are in `image/result.json`.
- `image/normal.rgba32f` and `albedo.rgba32f`: sample-averaged denoising guides,
  same RGBA layout; normals are not renormalized after averaging.
- `image/native-bvh.bin`: runtime-rebuilt traversal buffer, including the captured TLAS prefix.
- `image/result.json`: adapter, timing, capability flags and exact compilation scope.
- `cargo-target/release/libmutracer_native_probe.dylib` and `.a`: experimental libraries.
- `render-host`: standalone C consumer; it renders without invoking Node.
- `scene/scene.json`, binaries and WGSL: build-time prepared scene inputs.

Options:

- `MUTRACER_NATIVE_OUTPUT`: absolute output/evidence directory.
- `MUTRACER_NATIVE_SAMPLES`: sample count, default 64, range 1..4096.
- `CARGO_TARGET_DIR`: optional reusable Cargo build directory.
- `MUTRACER_NATIVE_FIXTURE`: `baseline` (default) or `transforms` (rotation,
  nonuniform scale, reflection and shear). Use baseline before `native:verify`.
- `MUTRACER_NATIVE_VALIDATE_SHADOWS=1`: compare each hybrid shadow decision with
  software traversal; diagnostic overhead is included in timings.
- `CC`: C compiler executable, default `cc`.

To run the already-built C consumer without Node:

```sh
.native-build/render-host .native-build/scene .native-build/another-image 256 repeat
```

`mutracer-probe.h` describes the experimental blocking C ABI. Calls must be
sequential on the same owner thread. This first version has no stable ABI,
independent contexts, job polling/cancellation, device-loss recovery or arbitrary live
scene updates. It consumes a prepared capture, not arbitrary TypeScript scenes.

`mt_probe_render_with_options` also accepts runtime camera translation, one
existing material's linear base color/roughness, bounce count and seed through
the size-checked `mt_probe_options` descriptor. These changes require no Node
process, scene recapture or shader rebuild. Camera orientation/projection and
raw geometry are still captured; material patches cannot enable new shader variants.
Each call starts from the capture again, so edits do not persist into later calls.

After `native:render`, verify these inputs and real ray-query execution:

```sh
npm run native:verify
```

Use the same output and Cargo target directories. The verifier serially checks
six native renders: baseline, zero camera translation, moved camera, roughness,
green material, and restored baseline. It also rejects three invalid input cases.
Images are under `variants/`, and `verification.json` records the checks. The
independent ray-query probe requires an adapter exposing the experimental
feature; failure leaves the software renderer available and is saved in its log.
The verifier then calls the experimental HWRT renderer from C and compares its
256-sample HDR and two guides with the software baseline. It then prepares and
renders baseline and affine-transform fixtures with every shadow decision checked
against software on the GPU. The fixture-specific same-adapter gate requires exact
normal/albedo bytes, zero shadow disagreements, color within 4 float32 ULP and
5e-7 absolute error, and exact alpha. This permits observed shader-compilation
roundoff; it is not a universal scene/driver tolerance. The result records the
metrics and actual hardware query counts.

## Select experimental hybrid HWRT

Set bit 2 (`flags = 4`) in `mt_probe_options`. The C ABI remains size-checked at
52 bytes. Forced HWRT reports an error if the adapter/capture is unsupported;
`flags = 0` continues to select software BVH. The prepared scene must have opaque
alpha, BVH2 geometry, no displacement and no shader bevel for this first version.

The hybrid backend uses hardware ray queries to select closest triangles, then
reuses MuTracer's watertight triangle test and surface completion for the exact
attribute arithmetic. Opaque shadow rays also use hardware queries, with exact
triangle checks and conservative software fallback. Closest-hit query misses are
confirmed with software traversal to preserve silhouette behavior. Rejected self
hits, back faces, shared-edge ties and numerical disagreements also fall back.

If any instance has nonuniform scale, reflection or shear, the whole scene keeps
software closest-hit traversal and hardware shadows. Broader affine closest-hit
parity exposed two guide pixels that conservative miss/edge fallbacks did not
resolve, so it remains deferred. `scene.json` records `hardwareClosest`, and
`result.json` reports the selected backend. The baseline uses uniform scale,
including its planar floor; world geometry is unchanged. The original software
functions remain available. This is partial traversal acceleration; diagnostic
atomics and miss confirmation add cost, and no speedup has been demonstrated.

`hardware-image/result.json` records accepted queries and software fallbacks.
Diagnostic atomics are currently always enabled and affect performance. Existing
alpha/displacement/bevel behavior is preserved by refusing unsupported captures,
not by pretending those surfaces are opaque.

## Compare browser and native HDR

```sh
npm run native:browser-reference
```

Open the printed loopback URL in a WebGPU browser. It uses the exact captured
shader, buffers, textures, camera, seed and 256 samples, then saves the real
browser HDR and normal/albedo guide output under `browser-reference/`. Use the same output directory as
`native:render`. Compare little-endian linear HDR buffers with:

```sh
node native/compare-hdr.mjs .native-build/browser-reference/render.rgba32f .native-build/variants/baseline/render.rgba32f
```

The tool reports finite-value checks, RGB error metrics and alpha differences.
It does not invent a universal tolerance or declare arbitrary scenes equivalent.

## What executes where

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
| Reachable async in scriptc library mode | SC4005; keep asynchronous orchestration in native host and scene preparation at build time | Native lifecycle/step API validated |
| Outbound FFI in library mode | `--lib --ffi` rejected by installed 0.3.2; host calls AOT and copies returned commands | Extend returned command/data protocol as needed |
| Whole entry/package lowering | Twelve shared computation graphs compile; browser MaterialTable and complete Engine/Render still depend on platform resources and asynchronous APIs | Native facade builds and accepts scenes through the C API |
| Native scene preparation | Camera/material edits and runtime BVH2 BLAS rebuilding work; raw geometry, TLAS/instances and scene/material/light packing stay build-time | Geometry/scene commit API, native TLAS and remaining preparation modules |
| Complete public API | Engine/Render facade, Three.js/Canvas equivalents and other runtime exports pending | Public-export/feature parity matrix completed |
| Denoising and display parity | First image is raw path tracing with a simple native preview | OIDN/JNLM and native display pipeline compared |
| HWRT coverage | Opaque closest-hit and shadows integrated; affine scenes retain software closest-hit due unresolved guide differences | Affine closest-hit parity, broader scenes, alpha/displacement/bevel and performance evaluation |
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
unchanged by extraction. This remains partial AOT, not complete scene preparation.

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
