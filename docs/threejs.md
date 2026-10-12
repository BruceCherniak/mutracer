# Three.js integration

Build or load a scene with Three.js, keep it in sync with `THREESceneSync`, and
render `sync.scene` with MuTracer. Create the sync once and call `sync.update()`
before rendering each frame. Three.js is an optional peer dependency
(`npm install three`).

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Renderer, THREESceneSync, fromTHREECamera } from '@meimu/mutracer';

const threeScene = new THREE.Scene();
threeScene.add((await new GLTFLoader().loadAsync('model.glb')).scene);

const renderer = new Renderer({ canvas });
const sync = new THREESceneSync(threeScene);

function frame() {
  sync.update();
  renderer.render(sync.scene, fromTHREECamera(threeCamera));
  requestAnimationFrame(frame);
}
frame();
```

MuTracer `transform` receives the Three.js `matrixWorld` (world transform), not its local `matrix`.

## Keeping scenes in sync

`THREESceneSync` constructs its initial `scene` immediately. Each `update()`
calls `updateMatrixWorld()` and re-reads the source scene. Unchanged meshes,
materials, textures, lights, background and membership arrays retain identity.
Transforms update the existing matrix arrays. Shared Three.js materials and
textures stay shared in MuTracer, including within a one-shot conversion.

```ts
threeMesh.rotation.y += 0.01;
threeMaterial.color.setRGB(0.4, 0.2, 0.1);
threeMaterial.roughness = 0.6;
sync.update();
renderer.render(sync.scene, fromTHREECamera(threeCamera));
```

Transforms, membership, lights, background and material properties need no
flag: material edits are converted and versioned automatically, so Three.js
`material.needsUpdate` is not required for color or roughness edits. Buffer
and pixel edits need the usual Three.js flags:

| Edit | Flag |
| --- | --- |
| Attribute or index array elements | `attribute.needsUpdate = true` (`attribute.data.needsUpdate` for interleaved) |
| Texture pixels or canvas | `texture.needsUpdate = true` |
| Instance matrices / colors | `instanceMatrix.needsUpdate` / `instanceColor.needsUpdate = true` |

```ts
geometry.attributes.position.setX(0, 0.5);
geometry.attributes.position.needsUpdate = true;
texture.needsUpdate = true; // after changing its canvas or pixel data
sync.update();
```

The sync then calls the right MuTracer notification (`markUpdated()` or
`markVerticesUpdated()`) on its converted resources. Changed position, normal,
tangent, uv, uv1 or index buffers replace the converted geometry, which costs
a [full mesh update](./updates.md#full-mesh-updates); skinning and morph
targets update arrays in place instead.

`update()` returns `void`. Render `sync.scene` afterwards; Renderer detects
the converted scene changes.

`new THREESceneSync(threeScene, options?)` accepts an optional
`onMeshConverted(mesh, source, group, groupIndex)` callback (default: none).
The sync calls it for each visible group and expanded instance during initial
conversion and every update.
Call `sync.dispose()` when finished to release its caches. Its last scene
remains usable; calling `update()` after disposal throws.

`fromTHREEScene(threeScene, options?)` remains available for one-shot conversion
with the same options. Every call creates fresh MuTracer objects.

`fromTHREECamera(camera)` is cheap; call it every frame. Call
`camera.updateProjectionMatrix()` after changing its aspect or fov. A
perspective camera's `focus` and film height (`filmGauge`) become the
[depth of field](./getting-started.md#depth-of-field) focus distance and sensor
height; pass `{ fStop }` to enable it, e.g. `fromTHREECamera(camera, { fStop: 2.8 })`.

## What is converted

| Three.js | MuTracer |
| --- | --- |
| `Mesh` with `MeshStandardMaterial` / `MeshPhysicalMaterial` | `Mesh` + `OpenPBRMaterial` (color, metalness, roughness, maps, normal map, emissive, transmission, attenuation, IOR, clearcoat, sheen, iridescence, anisotropy, alpha) |
| `Mesh` with `MeshBasicMaterial` (glTF `KHR_materials_unlit`) | Unlit emissive material |
| `SkinnedMesh` / mesh with morph targets | CPU-deformed dynamic geometry |
| `InstancedMesh` | One mesh per instance, sharing geometry and BLAS; cached color material variants |
| Multi-material groups | One MuTracer mesh per group |
| `DirectionalLight` | `DirectionalLight` |
| `PointLight` | `SphereLight` (radius `userData.mutracerRadius`, default 0.25) |
| `SpotLight` | `SpotLight` (radius `userData.mutracerRadius`, default 0.01; `penumbra` sets the inner angle) |
| `RectAreaLight` | `RectLight` |
| `AmbientLight` | `AmbientLight` |
| `scene.environment` (equirectangular float `DataTexture`, e.g. from `HDRLoader`/`RGBELoader`) | `EnvironmentLight` |
| `scene.background` color / texture | Background; the environment itself when `background === environment` |

Invisible objects are skipped. Other material types are skipped with a console
warning. `BatchedMesh`, instanced morph targets (`morphTexture`) and skinned
instancing are unsupported: each source object warns once per converter and is
converted as an ordinary mesh.

Meshes without UVs get automatic triplanar texture and displacement
projection through a cached copy of their material; explicit
`mutracerUvProjection` settings take precedence.

## Skinning and morph targets

The initial conversion and each `sync.update()` evaluate morph targets and
skinning on the CPU. The sync calls `skeleton.update()` itself, so a preceding
Three.js render is unnecessary. Relative and absolute morph targets affect
positions and normals; skinning transforms positions, normals and supplied
tangents in local space. Missing tangents are generated from the deformed
positions, normals and UVs. The mesh's world transform remains an instance
transform.

Each deforming source mesh owns its MuTracer geometry, even when several
SkinnedMesh objects share a Three.js BufferGeometry; deformation is computed
once per source mesh and copied to each material group. These geometries are
[dynamic](./updates.md#dynamic-geometry).

An unchanged pose (bones, binding matrices, morph weights and attribute
versions) skips deformation. A changed pose updates the arrays in place, and
rendering refits only that geometry's BLAS and instances. CPU cost grows with
vertices, bone influences and material groups. Displaced deforming meshes need
a full mesh update on every pose change.

Try the procedural [animation example](../examples/animation.html). Pause the
animation to accumulate samples; changing a pose restarts accumulation.

## Instanced meshes

`InstancedMesh.count` expands to that many MuTracer meshes per material group,
all sharing the converted geometry and its BLAS. Each world matrix is
`source.matrixWorld * instanceMatrix[i]`.

- **Matrices**: after `instanceMatrix.needsUpdate = true`, rendering refits
  the affected instances.
- **Count**: changing `count` keeps the existing prefix and adds or removes the
  tail, which rebuilds the top-level BVH but reuses vertices and BLASes (see
  [adding and removing meshes](./updates.md#adding-removing-and-reassigning-meshes)).
- **Colors**: `instanceColor` multiplies `baseColor` (and `emissionColor` for
  unlit materials); set `instanceColor.needsUpdate = true` after edits. Each
  distinct RGB value adds a cached material per source material, kept until
  `sync.dispose()`. Reuse colors to bound material count and memory.

## `userData` keys

Renderer-specific settings without a Three.js equivalent:

| Key | On | Description |
| --- | --- | --- |
| `mutracerShadowCatcher: true` | material | Shadow-catcher ground |
| `mutracerOpenPBR: { ... }` | material | OpenPBR inputs without a Three.js equivalent: `baseWeight`, `baseDiffuseRoughness`, `specularWeight`, `specularColor`, `coat*`, `fuzz*`, `thinFilm*`, `thinWalled`, `subsurface*`, `transmissionScatter*`, `transmissionDispersion*` |
| `mutracerBevelSize` | material | Shader bevel radius |
| `mutracerUvProjection`, `mutracerUvProjectionScale`, `mutracerUvReferenceLength` | material | Procedural UV projection |
| `mutracerDisplacement*` | material | Displacement settings, same names as the `OpenPBRMaterial` fields |
| `mutracerThinFilmMap` | material | Thin-film thickness texture |
| `mutracerRadius` | point / spot light | Emitter radius |
| `mutracerIesProfile`, `mutracerIesRotation` | spot light | `IESProfile` instance; rotation becomes local-Z transform rotation |
| `mutracerGroundedSkybox: { texture, height, radius, groundHeight?, center? }` | scene | Grounded skybox background |
| `mutracerHiddenBackground: true` | scene | Transparent background while keeping environment lighting |

Directional and spot lights use their world position and target to build a
MuTracer transform; source rotation alone does not specify their direction.
