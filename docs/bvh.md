# BVH construction

Every geometry needs a bottom-level BVH (BLAS); the renderer combines them
under a top-level BVH (TLAS) over the mesh instances.

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

To build up front, for example behind a loading screen:

```ts
renderer.bvhBuilder = 'tinybvh';
await renderer.prepareScene(scene);
```

`renderer.bvhSpatialSplits = true` (default `false`) makes TinyBVH use spatial
splits (SBVH). SBVH lowers traversal cost on some scenes, which can make
rendering noticeably faster, but builds three to five times slower than the
binned builder.

BVHs are stored on the `Geometry` (`geometry.bvh`). Share one geometry between
meshes to share its BLAS. After editing geometry arrays, call
`geometry.markUpdated()`; the next render automatically refits or rebuilds
the BLAS. Replacing `mesh.geometry` is detected automatically.

## Layouts

`renderer.bvhLayout` selects the layout for newly built static TinyBVH BLASes.
Changing it does not replace existing BVHs; use `rebuild: true` to rebuild them
with the current builder, layout and spatial-split settings:

```ts
renderer.bvhBuilder = 'tinybvh';
renderer.bvhLayout = 'cwbvh';
const stats = await renderer.prepareScene(scene, {
  rebuild: true,
  onProgress: progress => updateLoadingScreen(progress)
});
```

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

`prepareScene` returns `{ geometryCount, bvhTimeMs }`. The count covers BLASes
written by this call, with shared geometry counted once. The time sums builder
work and excludes queueing and WASM loading. Dynamic geometry is skipped.
Without `rebuild`, already prepared static BLASes are skipped; replacements
leave the old BLAS available until the new one is ready. `onProgress` receives
a completed fraction after each build (including failed or discarded results),
ending at `1`; a call with no builds does not invoke it.

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

After editing arrays in place, call `geometry.markUpdated()`. If attribute and
index array identities, lengths and item sizes remain unchanged, both backends
update only that geometry's merged vertex ranges and BLAS. All instances that
share the geometry receive refreshed bounds and a TLAS refit. Changes to
vertex attributes, transforms and materials can be combined in one frame.
Replaced arrays or changed lengths require full preparation. Changed index
contents rebuild the affected BLAS. Displaced geometry also
requires full preparation to refresh its displacement bounds and geometry data.

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
