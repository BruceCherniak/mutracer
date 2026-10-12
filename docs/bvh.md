# BVH construction

Every geometry needs a bottom-level BVH (BLAS); the renderer combines them
under a top-level BVH (TLAS) over the mesh instances. Static BLASes build
automatically in a Worker pool, so most applications need no BVH code at all.

| Setting | Default | Description |
| --- | --- | --- |
| `renderer.bvhBuilder` | `'builtin'` | `'builtin'` (JavaScript) or `'tinybvh'` (WebAssembly, loaded on first use) |
| `renderer.bvhWorkerCount` | `'auto'` | Maximum Workers per renderer: `'auto'` or a positive safe integer. Auto uses `hardwareConcurrency - 1`, clamped to 1–4; 1 when unavailable |
| `renderer.bvhLayout` | `'bvh2'` | Layout of static TinyBVH BLASes: `'bvh2'`, `'bvh4'`, `'bvh-gpu'` or `'cwbvh'` |
| `renderer.bvhSpatialSplits` | `false` | With `'tinybvh'`, build spatial-split BVHs (SBVH) |
| `geometry.dynamic` | `false` | Refittable built-in BLAS for deforming geometry; see [dynamic geometry](./updates.md#dynamic-geometry) |

## Choose a preparation flow

The examples assume you have created `renderer`, `scene` and `camera`.

### Automatic (default)

`render()` builds missing static BLASes in the Worker pool. Keep calling it while it
returns `'preparing'` or `'compiling'`; the
canvas keeps its previous image meanwhile:

```ts
function frame() {
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
```

Without Worker support, the built-in builder runs synchronously inside
`render()` and can pause the page.

### Prepare before the render loop

For a loading screen, await the missing static BLASes first. This works with
either builder:

```ts
renderer.bvhBuilder = 'tinybvh';
renderer.bvhWorkerCount = 4;

const stats = await renderer.prepareScene(scene, {
  onProgress: progress => console.log(`BVH tasks: ${Math.round(progress * 100)}%`)
});
console.log(stats.geometryCount, stats.bvhTimeMs);

frame(); // start the render loop above
```

`prepareScene` accepts a scene or a `Mesh[]`. It skips existing BLASes, empty
geometry and dynamic geometry, and builds shared geometry once.

### Configure parallel construction

`renderer.bvhWorkerCount = 'auto'` (the default) selects up to four Workers,
leaving one reported CPU thread free where possible. Set a positive safe
integer to choose the limit explicitly:

```ts
renderer.bvhWorkerCount = 8;
await renderer.prepareScene(scene);
```

Both builders parallelize across independent geometries. A single geometry's
BLAS still builds on one Worker; `1` uses serial construction. Workers are
created only when needed, so a scene with two missing BLASes uses at most two
Workers even with a higher limit. A pool is owned by its renderer and reused
between preparations. Call `renderer.dispose()` to release it.

Changing the count takes effect when the next preparation starts. Active
preparations finish with their current pool; existing BLASes need no rebuild.
Invalid counts (including zero, fractions and infinity) throw `RangeError`.

### Rebuild after changing builder settings

Changing `bvhBuilder`, `bvhLayout` or `bvhSpatialSplits` affects future builds
only. To apply new settings to a prepared scene, rebuild its static BLASes:

```ts
renderer.bvhBuilder = 'tinybvh';
renderer.bvhLayout = 'cwbvh';
renderer.bvhSpatialSplits = true;

await renderer.prepareScene(scene, { rebuild: true });
// The next render uses the replacement BLASes.
```

Old BLASes stay in use until their replacements are ready. Dynamic geometry
keeps the built-in builder.

## What `prepareScene` completes

`await renderer.prepareScene(scene)` waits for static BLAS builds only. It
does **not** initialize the device, build the TLAS, upload GPU scene data,
compile shaders or render. Afterwards, keep calling `render()` through
`'preparing'` and `'compiling'`, or await
`renderOfflineFrame(scene, camera, { samples })` for a finished image.

- **Result** `{ geometryCount, bvhTimeMs }`: `geometryCount` is the number of
  BLASes this call wrote, with shared geometry counted once. `bvhTimeMs` sums
  builder time; it excludes queueing and WASM loading and is not elapsed time.
- **Progress** `onProgress(fraction)` counts completed build tasks, not
  triangles or time. Failed and stale tasks count as completed, so reaching
  `1` does not guarantee every BLAS was written. A call with nothing to build
  returns zeros and never calls `onProgress`.
- **Stale results**: if a geometry changes during its build, the result is
  discarded. Render the updated scene, or prepare again.
- **Errors**: invalid inputs are reported by the next `render()`.
- **Disposal**: `renderer.dispose()` cancels active and queued preparations.
  Completed BLASes remain on their geometries; cancelled calls resolve with
  their partial statistics, without further progress callbacks or fallback builds.

More Workers increase simultaneous input copies and, with TinyBVH, the number
of WASM instances. Increase the limit only with sufficient memory; extra
Workers do not necessarily improve elapsed time. `bvhTimeMs` adds up work
across Workers and can exceed elapsed time. Measure wall time around
`await renderer.prepareScene(scene)` when comparing pool sizes. TLAS
construction and GPU uploads are separate costs.

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

`renderer.bvhLayout` applies to newly built static TinyBVH BLASes. All four
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
  `prepareScene` call; TinyBVH failures retry with the built-in builder. Each
  fallback warns once per renderer.
- Concurrent `prepareScene` calls on one renderer are queued and check for missing BLASes when
  they start, so they do not repeat completed builds.
- Height-map analysis, attribute generation, TLAS construction and per-frame
  refits run on the calling thread.

## Rebuilding the WebAssembly module

`src/tinybvh/tinybvh.wasm` is checked in. To rebuild it, install Emscripten and
run `npm run build:tinybvh` (or `npm run build:tinybvh:windows`). See
[`src/tinybvh/README.md`](../src/tinybvh/README.md).

BVH storage is internal. To rebuild using the current construction settings, call `await renderer.prepareScene(scene, { rebuild: true })`; geometry exposes no BVH field.
