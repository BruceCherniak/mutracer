# BVH construction

Every geometry needs a bottom-level BVH (BLAS); the renderer combines them
under a top-level BVH (TLAS) over the mesh instances.

## Default: TinyBVH

`renderer.bvhBuilder = 'tinybvh'` (default) builds missing BLASes with
[TinyBVH](https://github.com/jbikker/tinybvh) compiled to WebAssembly, before
the first frame that needs them. `render()` returns `RENDER_STATUS_PREPARING`
while it builds and keeps showing the previous scene. The module (about
90 KB) is loaded on first use. If it fails to load, the renderer logs a warning
and falls back to the built-in JavaScript builder.

To build up front, for example behind a loading screen:

```ts
await renderer.prepareScene(scene);
```

`renderer.bvhBuilder = 'builtin'` uses the synchronous JavaScript SAH builder
inside `render()`.

BVHs are stored on the `Geometry` (`geometry.bvh`). Share one geometry between
meshes to share its BLAS. After editing geometry arrays, call
`geometry.markUpdated()` and `renderer.markMeshesDirty()`; the BLAS is refit
or rebuilt.

## Layouts

`precomputeTinyBvh(meshes, layout)` builds BLASes explicitly in another layout:

| Layout | Notes |
| --- | --- |
| `'bvh2'` | Default; binary BVH |
| `'bvh4'` | 4-wide BVH |
| `'bvh-gpu'` | TinyBVH's `BVH_GPU` layout |
| `'cwbvh'` | Compressed 8-wide BVH (WebGPU); experimental, benefit depends on GPU and scene |

```ts
import { precomputeTinyBvh } from 'claypt';
const stats = await precomputeTinyBvh(scene.meshes, 'cwbvh');
```

## Animation

On WebGPU, transform-only changes refit the TLAS instead of rebuilding it.
Either replace `scene.meshes`, or keep the array and call
`renderer.markMeshTransformsDirty(changedMeshes)`.

## Worker precomputation

For large scenes or tessellated displacement, do the work in a Web Worker:

```ts
// main thread
import { prepareForPrecompute, resolveFromPrecompute } from 'claypt';

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
  renderer.markMeshesDirty();
};

// worker.ts
import { precompute } from 'claypt';

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
