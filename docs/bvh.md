# BVH construction

Every geometry needs a bottom-level BVH (BLAS); the renderer combines them
under a top-level BVH (TLAS) over the mesh instances.

## Choose a preparation flow

The examples below assume you have created `renderer`, `scene` and `camera`.

### Automatic preparation during rendering

No explicit preparation call is needed. By default, `render()` builds missing
static BLASes with the built-in builder in a Worker. Keep calling it while it
returns `RENDER_STATUS_PREPARING` or `RENDER_STATUS_COMPILING_SHADER`:

```ts
function frame() {
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
```

The canvas retains its previous image while automatic BVH preparation is in
progress. Without Worker support, the built-in builder runs synchronously on
the calling thread and can pause the page during construction.

### Prepare before starting the render loop

For a loading screen, explicitly await the missing static BLASes. This works
with either builder; TinyBVH loads its WASM on first use:

```ts
renderer.bvhBuilder = 'tinybvh';
renderer.bvhLayout = 'bvh2';

const stats = await renderer.prepareScene(scene, {
  onProgress: progress => console.log(`BVH tasks: ${Math.round(progress * 100)}%`)
});
console.log(stats.geometryCount, stats.bvhTimeMs);

// Start the render loop above after preparation completes.
frame();
```

By default, existing static BLASes are skipped. Shared geometry is built once;
empty and dynamic geometries are skipped. `prepareScene` accepts a scene with
`meshes`, or a `Mesh[]` directly.

### Rebuild after switching builder settings

Changing `bvhBuilder`, `bvhLayout` or `bvhSpatialSplits` affects subsequent
builds; it does not replace existing BLASes. To apply new settings to an
already prepared scene, explicitly rebuild its static BLASes:

```ts
renderer.bvhBuilder = 'tinybvh';
renderer.bvhLayout = 'cwbvh';
renderer.bvhSpatialSplits = true;

await renderer.prepareScene(scene, {
  rebuild: true,
  onProgress: progress => console.log(`BVH tasks: ${Math.round(progress * 100)}%`)
});
// The next render refreshes scene data using the replacement BLASes.
```

Old BLASes remain available until their replacements are ready. Dynamic
geometry continues to use the built-in builder, regardless of these settings.

## What `prepareScene` completes

`await renderer.prepareScene(scene)` waits for this call's static BLAS tasks
and writes back results that still match the geometry and displacement inputs.
It does **not** initialize the rendering device, build the scene TLAS, pack or
upload GPU scene data, compile shaders, or render an image. Those steps happen
in the rendering flow. After preparation, continue calling `render()` through
`RENDER_STATUS_PREPARING` and `RENDER_STATUS_COMPILING_SHADER`; to await a
finished image, use `renderOfflineFrame(scene, camera, { samples })`.

It returns `{ geometryCount, bvhTimeMs }`. The count covers BLASes actually
written by this call, with shared geometry counted once. The time sums builder
work and excludes queueing and WASM loading; it is not elapsed loading time.
`onProgress` reports the fraction of completed build tasks, not triangle count
or estimated time. Failed and discarded tasks also count as completed, so
progress reaching `1` does not guarantee every BLAS was written. A call with
no builds returns zero counts and does not invoke the progress callback.
Invalid inputs are reported by the synchronous rendering path. If inputs
change during a build, its stale result is discarded; render the updated scene
or prepare it again to build any missing BLASes.

Preparation uses a Worker when available, but height-map analysis and attribute
generation still run on the calling thread. TLAS construction and per-frame
geometry updates also remain on that thread. For fallback details, see
[Worker preparation](#worker-preparation).

## Default: built-in builder

`renderer.bvhBuilder = 'builtin'` (default) builds missing BLASes
in a reusable Web Worker before rendering. `render()` returns
`RENDER_STATUS_PREPARING` until preparation finishes; `await renderer.prepareScene(scene)`
builds up front. Without Worker support, it builds synchronously inside `render()`. The builder is a port of
[TinyBVH](https://github.com/jbikker/tinybvh)'s binned SAH builder
(`BVH::Build`). It computes in float64, so where split costs nearly tie it
can choose differently from TinyBVH's float32 build; tree quality is the
same. The TLAS over mesh instances and the BLASes of dynamic geometries
always use it.

## Optional: TinyBVH WebAssembly

`renderer.bvhBuilder = 'tinybvh'` builds static BLASes with TinyBVH compiled
to WebAssembly inside the same Worker, about 1.3 times faster than the JavaScript builder. The
module (about 90 KB) is imported and fetched on first use, so applications
that keep the default do not load it. BLASes are built
asynchronously before the first frame that needs them: `render()` returns
`RENDER_STATUS_PREPARING` meanwhile and keeps showing the previous scene. If
the module fails to load, the renderer logs a warning and falls back to the
built-in builder.

`renderer.bvhSpatialSplits = true` (default `false`) makes TinyBVH use spatial
splits (SBVH). SBVH lowers traversal cost on some scenes, which can make
rendering noticeably faster, but builds three to five times slower than the
binned builder.

BVHs are stored on the `Geometry` (`geometry.bvh`). Share one geometry between
meshes to share its BLAS. Geometry edits require an update notification;
see [Animation](#animation) for the two update methods. Replacing
`mesh.geometry` is detected automatically.

## Layouts

`renderer.bvhLayout` selects the layout for newly built static TinyBVH BLASes.
Use the [rebuild flow](#rebuild-after-switching-builder-settings) to replace
existing BVHs with the current builder, layout and spatial-split settings.

| Layout | Notes |
| --- | --- |
| `'bvh2'` | Default; binary BVH |
| `'bvh4'` | 4-wide BVH |
| `'bvh-gpu'` | TinyBVH's `BVH_GPU` layout |
| `'cwbvh'` | Compressed 8-wide BVH; experimental, benefit depends on GPU and scene |

All four layouts are supported on WebGPU and WebGL 2. The built-in builder,
dynamic geometry and TinyBVH displacement bounds use `'bvh2'`. TinyBVH may
use `'bvh-gpu'` if CWBVH conversion cannot represent a mesh; inspect
`geometry.bvh.layout` for the actual layout.

## Animation

Transform-only changes refit the TLAS on both WebGPU and WebGL 2.
Edit `mesh.matrixWorld` in place while retaining mesh objects and the array;
the renderer compares matrix values automatically. WebGPU uploads changed
byte ranges; WebGL 2 uploads the texture rows covering those ranges.

For frequent vertex deformation, set `geometry.dynamic = true` (default:
`false`). Dynamic geometries always use the built-in binary `bvh2` layout,
including when the renderer otherwise uses TinyBVH with a different
`bvhLayout`. An incompatible precomputed BLAS is rebuilt.
Three.js skinning and morph conversion sets this hint automatically.

Choose the notification that matches the edit:

| Edit | Notification | Effect |
| --- | --- | --- |
| Vertex attributes only, with indices and `materialIndex` unchanged | `geometry.markVerticesUpdated()` | Advances `version` and preserves `topologyVersion`, allowing vertex updates and BLAS refits where supported |
| Indices or `materialIndex`, or a general geometry update | `geometry.markUpdated()` | Advances both revisions and requests topology processing, including rebuilding the affected BLAS |

For vertex animation, retain the attribute arrays, their lengths and item sizes:

```ts
geometry.dynamic = true;
geometry.position.array[0] += 0.1;
geometry.markVerticesUpdated();
// The next render updates this geometry and all its instances.
```

`markUpdated()` remains valid for vertex edits, but treats them as topology
updates and can rebuild the BLAS unnecessarily. Both methods cover all vertex
attributes; neither automatically recalculates normals or tangents after an
edit. Update those attributes as needed before notifying the renderer.

With stable arrays, both backends update only the affected geometry's merged
ranges and BLAS. All instances sharing it receive refreshed bounds and a TLAS
refit. Changes to vertex attributes, transforms and materials can be combined
in one frame. Replaced arrays, changed lengths or item sizes require full
scene data preparation regardless of the notification method. Displaced
geometry also requires full preparation to refresh displacement bounds and
geometry data. This rendering update work is separate from `prepareScene`,
which skips existing BLASes unless `rebuild: true` is requested.

Dynamic BLAS refits sum node surface areas and compare the total with the last
build. When it exceeds twice that build's total, the affected BLAS is rebuilt.
This limits deterioration during sustained deformation while retaining the
layout for smaller pose changes. If rebuilding changes a BLAS's size, the
combined BVH buffer is uploaded again; unchanged geometry buffers are retained.
Non-dynamic geometries refit supported layouts or rebuild unsupported ones.

Instance membership changes that use resident single-material geometry rebuild
TLAS and instance data while reusing vertices and BLASes. Structural changes
involving displacement or geometry-dependent multi-material
indices require full preparation.

## Worker preparation

Automatic static BLAS preparation uses a module Worker with either builder.
Inputs are cloned so shared geometry remains usable on the main thread; BVH
buffers are transferred back. Requests share one Worker, which serializes builds
and retains TinyBVH's WASM instance. Geometry revisions
and displacement settings are checked before accepting asynchronous results.
Input errors affect only the invalid mesh; they do not disable Workers for
other meshes. Worker startup, messaging or runtime failures retry with the same
builder on the calling thread within the same `prepareScene` call. TinyBVH
failures retry with the built-in builder. Both fallbacks log one warning per
renderer. Concurrent calls on a renderer are queued and check missing BLASes
when they start, so they do not duplicate completed builds. Invalid inputs are
reported by the synchronous rendering path.
The Worker entry is emitted with both the standalone build and npm ESM package;
serve it from the same origin and allow Workers in your content security policy.
TLAS construction and per-frame deformation refits/rebuilds remain synchronous.
Height-map analysis and other geometry preparation still run on the calling thread.

## Rebuilding the WebAssembly module

`src/tinybvh/tinybvh.wasm` is checked in. To rebuild it, install Emscripten and
run `npm run build:tinybvh` (or `npm run build:tinybvh:windows`). See
[`src/tinybvh/README.md`](../src/tinybvh/README.md).
