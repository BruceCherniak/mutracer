# BVH construction

`render()` automatically initializes the device, builds BVHs, uploads scene
resources and compiles shaders. Keep calling it while status is `preparing`
or `compiling`; the canvas retains its previous image.

```ts
renderer.on('progress', ({ stage, progress }) => loading.update(stage, progress));
renderer.on('status', ({ status }) => {
  if (status !== 'preparing' && status !== 'compiling') loading.hide();
});
function frame() { renderer.render(scene, camera); requestAnimationFrame(frame); }
frame();
```

| Use case | Action |
| --- | --- |
| Normal rendering | Run the render loop |
| Loading indicator | Listen to `progress` and `status` |
| Benchmark preparation | Timestamp status events |
| Offline image | Await `renderOfflineFrame()` |
| Prepare a future scene while another renders | Optional `await renderer.prebuildBVH(nextScene)` |
| Change builder, layout or spatial splits | Assign settings; the next render rebuilds automatically |

## Optional early construction

`prebuildBVH(sceneOrMeshes, { onProgress?, signal? })` only builds static
BLASes. It does not initialize a device, upload resources or compile shaders.
Both options default to undefined; an aborted call rejects with its abort
reason. Shared geometry builds once, dynamic/empty geometry is skipped.

```ts
await renderer.prebuildBVH(nextScene, {
  onProgress: fraction => console.log(fraction), signal: controller.signal
});
console.log(renderer.getDiagnostics()?.bvh?.lastBuild);
```

`lastBuild` contains `geometryCount` and `bvhTimeMs` (total builder time,
excluding queueing and WASM loading). It can be read after construction even
before device initialization; diagnostics `backend` is then undefined.
The preparation method resolves void. With no work, statistics are zero
and the callback is not invoked.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `renderer.bvhBuilder` | `'builtin'` | `'builtin'` (JavaScript) or `'tinybvh'` (WebAssembly, loaded on first use) |
| `renderer.bvhWorkerCount` | `'auto'` | Maximum Workers per renderer: `'auto'` or a positive safe integer. Auto uses `hardwareConcurrency - 1`, clamped to 1–4; 1 when unavailable |
| `renderer.bvhLayout` | `'bvh2'` | Layout of static TinyBVH BLASes: `'bvh2'`, `'bvh4'`, `'bvh-gpu'` or `'cwbvh'` |
| `renderer.bvhSpatialSplits` | `false` | With `'tinybvh'`, build spatial-split BVHs (SBVH) |
| `geometry.dynamic` | `false` | Refittable built-in BLAS for deforming geometry; see [dynamic geometry](./updates.md#dynamic-geometry) |

Changes to builder/layout/spatial splits invalidate cached build configurations.
Old BLASes stay usable until replacements finish; rendering reports preparing
through this work. Worker count changes affect the next build, with no BVH
rebuild required. Both builders parallelize independent geometries, while one
geometry builds on one Worker. Pools are reused and released by dispose().

## Caveats

Progress counts completed tasks, including failed/stale tasks, rather than
triangles or elapsed time. Renderer `progress` events cover device (0/1),
BVH tasks and shader pipelines only during preparing/compiling. Explicit
background prebuilds use their own `onProgress` callback.
Stale results are discarded. Without Worker support, construction runs on
the calling thread. More Workers increase simultaneous memory use, and
summed builder time can exceed wall time. Disposal cancels active and queued
preparations without further callbacks; completed CPU BVHs remain cached.

## Builders

### Built-in (default)

A JavaScript port of [TinyBVH](https://github.com/jbikker/tinybvh)'s binned
SAH builder (`BVH::Build`). It computes in float64, so where split costs
nearly tie it can choose differently from TinyBVH's float32 build; tree
quality is the same. The TLAS and dynamic BLASes always use it.

### TinyBVH WebAssembly

`renderer.bvhBuilder = 'tinybvh'` builds static BLASes with TinyBVH compiled
to WebAssembly, about 1.3 times faster than the built-in builder. The module
(about 90 KB) is fetched on first use, so applications that keep the default
never load it. If it fails to load, the renderer warns and falls back to the
built-in builder.

`renderer.bvhSpatialSplits = true` builds SBVHs. They lower traversal cost on
some scenes, which can make rendering noticeably faster, but build three to
five times slower.

BLASes are cached internally by geometry: share one `Geometry`
between meshes to share its BLAS.

## Layouts

`renderer.bvhLayout` applies to static TinyBVH BLASes, rebuilding them automatically when changed. All four
layouts work on WebGPU and WebGL 2.

| Layout | Notes |
| --- | --- |
| `'bvh2'` | Default; binary BVH |
| `'bvh4'` | 4-wide BVH |
| `'bvh-gpu'` | TinyBVH's `BVH_GPU` layout |
| `'cwbvh'` | Compressed 8-wide BVH; experimental, benefit depends on GPU and scene |

The built-in builder, dynamic geometry and TinyBVH displacement bounds use
`'bvh2'`. TinyBVH falls back to `'bvh-gpu'` when CWBVH cannot represent a
mesh. The geometry BVH cache is internal.

## Deployment

The Worker entry ships with both the standalone build and the npm ESM package.
Serve it from the same origin and allow Workers in your content security
policy. The bundled TinyBVH wasm is checked on download (HTTP status and file
signature); if that fails, MuTracer warns once and retries the version-pinned
jsDelivr copy, then falls back to the built-in builder. See
[bundler notes](./getting-started.md#bundler-notes).

## Implementation notes

- Each renderer owns a lazy module Worker pool. Each Worker handles one BLAS
  at a time and keeps its own TinyBVH WASM instance. Larger geometries start
  first; preparation lanes generate inputs only when ready to submit work.
  Only the used ranges of input attribute views are copied, and these owned
  copies are transferred to the Worker. Source geometry stays usable on the
  main thread; BVH buffers are transferred back.
- Geometry revisions and displacement settings are checked before an
  asynchronous result is accepted.
- An invalid input affects only its mesh. Worker startup, messaging or runtime
  failures retry with the same builder on the calling thread within the same
  preparation call; TinyBVH failures retry with the built-in builder. Each
  fallback warns once per renderer.
- Concurrent preparation calls on one renderer are queued and check for missing BLASes when
  they start, so they do not repeat completed builds.
- Height-map analysis, attribute generation, TLAS construction and per-frame
  refits run on the calling thread.

## Rebuilding the WebAssembly module

`src/tinybvh/tinybvh.wasm` is checked in. To rebuild it, install Emscripten and
run `npm run build:tinybvh` (or `npm run build:tinybvh:windows`). See
[`src/tinybvh/README.md`](../src/tinybvh/README.md).
