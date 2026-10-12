# Scene updates and animation

This page is the reference for editing a scene that is already rendering.
Keep the same `scene` object, arrays and resources between frames and edit
them in place. Each `render()` compares the scene with the previous call and
picks the cheapest update path. Any change that affects the image restarts
accumulation; while changes continue, `interactivePreview` renders a cheaper
image.

## What to do after a change

| Change | What to do |
| --- | --- |
| Camera or renderer option changed | Nothing; checked on each render |
| Meshes added, removed or reordered | Nothing; edit `scene.meshes` in place or replace the array |
| `mesh.matrixWorld` elements edited | Nothing |
| `mesh.geometry` or a mesh material replaced | Nothing |
| Lights added, removed or their parameters edited | Nothing |
| Background assigned, or its color or grounded-skybox fields edited | Nothing |
| Texture, image, UV array, `flipY` or `uvChannel` assigned | Nothing |
| Material parameters edited | `material.markUpdated()` |
| Texture pixels or UV-array elements edited | `texture.markUpdated()` |
| Vertex attributes edited; indices and `materialIndex` unchanged | `geometry.markVerticesUpdated()` |
| Indices, `materialIndex` or other geometry data edited | `geometry.markUpdated()` |
| `bvhBuilder`, `bvhLayout` or `bvhSpatialSplits` changed | Affects future builds; `await renderer.prepareScene(scene, { rebuild: true })` replaces existing BLASes ([BVH](./bvh.md#rebuild-after-changing-builder-settings)) |

```ts
mesh.matrixWorld[12] += 0.1;           // detected automatically
material.specularRoughness = 0.6;
material.markUpdated();
renderer.render(scene, camera);
```

With Three.js, edit the Three.js scene and call `sync.update()` before
rendering; the sync sends these notifications for you. See
[Three.js](./threejs.md#keeping-scenes-in-sync).

## Checking missing material notifications

Use `new Renderer({ canvas, validateUpdates: true })` to diagnose forgotten
`material.markUpdated()` calls. The default is on in development builds and off
in production builds or native browser ESM. Pass `false` to disable it explicitly.

Each render checks up to 200 materials in rotation, comparing parameters and
vector elements with their previous inspection. A parameter change without a
material version change warns once per material. It does not update the material
for you. Automatically detected texture references, versions and metadata do not
warn. Geometry arrays and texture pixels are not inspected; changes made before
a material's first inspection have no baseline to compare.

## Transforms

Edit `mesh.matrixWorld` in place while retaining the mesh objects and the
`scene.meshes` array. Both WebGPU and WebGL 2 refit the top-level BVH over the
changed instances and upload only the affected ranges.

## Materials, textures and lights

`material.markUpdated()` repacks material parameters without touching geometry
or BVHs. Emission edits also refresh light-sampling state, and texture edits
rebuild the texture atlas. Displacement settings that move geometry require a
[full mesh update](#full-mesh-updates); `displacementBumpStrength` affects
shading only and takes the texture path.

Analytic-light edits keep the environment map. Ambient and environment edits
rebuild it. Rect-light texture edits require a full mesh update, because those
textures live in the material atlas.

## Geometry

Choose the notification that matches the edit:

| Edit | Notification | Effect |
| --- | --- | --- |
| Vertex attributes only; indices and `materialIndex` unchanged | `geometry.markVerticesUpdated()` | Advances `version`; keeps `topologyVersion`. Allows vertex updates and BLAS refits |
| Indices, `materialIndex`, or any other geometry change | `geometry.markUpdated()` | Advances `version` and `topologyVersion`. Rebuilds the affected BLAS |

```ts
geometry.dynamic = true;               // for frequent deformation
geometry.position.array[0] += 0.1;
geometry.markVerticesUpdated();
// The next render updates this geometry and every mesh that uses it.
```

- Neither method recalculates normals or tangents. Update them before
  notifying the renderer.
- `markUpdated()` is valid for vertex edits too, but it can rebuild the BLAS
  unnecessarily.
- Keep the attribute arrays, their lengths and item sizes. Then both backends
  update only the edited geometry's ranges and BLAS, and refit every instance
  that shares it. Vertex, transform and material edits can be combined in one
  frame.
- Replaced arrays, changed lengths or item sizes, and displaced geometry
  require a [full mesh update](#full-mesh-updates), whichever method you call.

### Dynamic geometry

Set `geometry.dynamic = true` (default `false`) for geometry that deforms
every frame. Dynamic geometry always uses the built-in builder and the binary
`'bvh2'` layout, whatever `renderer.bvhBuilder` and `renderer.bvhLayout` say,
so its BLAS can be refitted. A refitted BLAS is rebuilt once its total node
surface area exceeds twice the total of its last build, which limits quality
loss during long deformations. Non-dynamic geometry refits layouts that
support it and rebuilds the others.

Refits and rebuilds run synchronously during `render()`. Three.js skinning
and morph targets set `dynamic` automatically; try the
[animation example](../examples/animation.html).

## Adding, removing and reassigning meshes

Adding, removing or reordering meshes, or replacing a mesh's material, is
cheap when every mesh uses a single material and geometry that is already on
the GPU: the renderer rebuilds the top-level BVH and instance data and reuses
vertex data and BLASes. Otherwise, for example with new geometry, displacement
or a `materialIndex` attribute, it needs a full mesh update.

## Full mesh updates

A full mesh update repacks and uploads all mesh data, and its cost grows with
the whole scene rather than with the edit. It happens when:

- attribute or index arrays are replaced, or their lengths or item sizes change;
- displaced geometry or its displacement settings change;
- a rect-light texture changes;
- a mesh gets geometry that is not yet on the GPU, or meshes with displaced
  or multi-material geometry are added, removed or reassigned.

Avoid these in per-frame animation.
