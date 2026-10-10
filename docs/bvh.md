# BVH construction

Every geometry needs a bottom-level BVH (BLAS); the renderer combines them
under a top-level BVH (TLAS) over the mesh instances.

## Default: built-in builder

`renderer.bvhBuilder = 'builtin'` (default) builds missing BLASes
synchronously in JavaScript inside `render()`. The builder is a port of
[TinyBVH](https://github.com/jbikker/tinybvh)'s binned SAH builder
(`BVH::Build`). It computes in float64, so where split costs nearly tie it
can choose differently from TinyBVH's float32 build; tree quality is the
same. The TLAS over mesh instances and the BLASes of dynamic geometries
always use it.

## Optional: TinyBVH WebAssembly

`renderer.bvhBuilder = 'tinybvh'` builds static BLASes with TinyBVH compiled
to WebAssembly, about 1.3 times faster than the JavaScript builder. The
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

`precomputeTinyBvh(meshes, layout, onProgress, { spatialSplits })` builds
BLASes explicitly, optionally in another layout or with SBVH:

| Layout | Notes |
| --- | --- |
| `'bvh2'` | Default; binary BVH |
| `'bvh4'` | 4-wide BVH |
| `'bvh-gpu'` | TinyBVH's `BVH_GPU` layout |
| `'cwbvh'` | Compressed 8-wide BVH (WebGPU); experimental, benefit depends on GPU and scene |

```ts
import { precomputeTinyBvh } from '@meimu/mutracer';
const stats = await precomputeTinyBvh(scene.meshes, 'cwbvh');
```

Returned counts and timings cover geometries processed by this call, including
dynamic geometries built with the built-in builder. Processing multiple layouts
reports `layout: 'mixed'`; `builder` names the precomputation entry point. Inspect each `geometry.bvh.builder` and
`geometry.bvh.layout` for its actual builder/layout.

## Animation

Transform-only changes refit the TLAS on both WebGPU and WebGL 2.
Edit `mesh.matrixWorld` in place while retaining mesh objects and the array;
the renderer compares matrix values automatically. WebGPU uploads changed
byte ranges; WebGL 2 uploads the texture rows covering those ranges.

For frequent vertex deformation, set `geometry.dynamic = true` (default:
`false`). Dynamic geometries always use the built-in binary `bvh2` layout,
including when the renderer otherwise uses TinyBVH or a precomputation request
selects a different layout. An incompatible precomputed BLAS is rebuilt.
Three.js skinning and morph conversion sets this hint automatically.

After editing arrays in place, call `geometry.markUpdated()`. If attribute and
index array identities, lengths and item sizes remain unchanged, both backends
update only that geometry's merged vertex ranges and BLAS. All instances that
share the geometry receive refreshed bounds and a TLAS refit. Changes to
vertex attributes, transforms and materials can be combined in one frame.
Replaced arrays or changed lengths require full preparation. Changed index
contents rebuild the affected BLAS. Displaced or simplified geometry also
requires full preparation because it changes the prepared vertex topology.

Dynamic BLAS refits sum node surface areas and compare the total with the last
build. When it exceeds twice that build's total, the affected BLAS is rebuilt.
This limits deterioration during sustained deformation while retaining the
layout for smaller pose changes. If rebuilding changes a BLAS's size, the
combined BVH buffer is uploaded again; unchanged geometry buffers are retained.
Non-dynamic geometries refit supported layouts or rebuild unsupported ones.

Instance membership changes that use resident single-material geometry rebuild
TLAS and instance data while reusing vertices and BLASes. Structural changes
involving displacement, simplification or geometry-dependent multi-material
indices require full preparation.

## Worker precomputation

For large scenes or tessellated displacement, do the work in a Web Worker
before entering the render loop. Resume rendering after resolving the result:

```ts
// main thread
import { prepareForPrecompute, resolveFromPrecompute } from '@meimu/mutracer';

const prepared = prepareForPrecompute(scene.meshes);
const {
  geometries, displacementScales, trianglesDisplacements,
  tessellations, projectiveDisplacements, geometryPostprocessOptions
} = prepared;
worker.postMessage(
  { geometries, displacementScales, trianglesDisplacements,
    tessellations, projectiveDisplacements, geometryPostprocessOptions },
  prepared.buffers
);
worker.onmessage = ({ data }) => {
  resolveFromPrecompute(data, prepared);
  // Start rendering after the transferred geometry and BVHs are resolved.
  requestAnimationFrame(frame);
};

// worker.ts
import { precompute } from '@meimu/mutracer';

self.onmessage = async ({ data: d }) => {
  const result = await precompute(
    d.geometries, d.displacementScales, d.trianglesDisplacements,
    undefined,               // buildBVH: defaults to the built-in builder
    d.tessellations,
    undefined,               // onProgress
    d.projectiveDisplacements,
    undefined,               // refineDisplacementTopology (OpenSubdiv)
    undefined,               // postprocessDisplacementGeometry
    d.geometryPostprocessOptions
  );
  self.postMessage(result, result.buffers);
};
```

`precompute` accepts an optional `buildBVH` function (for example one that
calls TinyBVH) and, for `displacementTessellationMode = 'opensubdiv'`, an
asynchronous `refineDisplacementTopology` callback that runs an OpenSubdiv
build supplied by the application.

## Rebuilding the WebAssembly module

`src/tinybvh/tinybvh.wasm` is checked in. To rebuild it, install Emscripten and
run `npm run build:tinybvh` (or `npm run build:tinybvh:windows`). See
[`src/tinybvh/README.md`](../src/tinybvh/README.md).
