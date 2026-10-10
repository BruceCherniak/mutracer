# Three.js integration

Build or load a scene with Three.js and render it with MuTracer. Three.js is an
optional peer dependency (`npm install three`).

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Renderer, THREESceneSync, fromTHREECamera } from 'mutracer';

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
const changes = sync.update();
renderer.render(sync.scene, fromTHREECamera(threeCamera));
```

`changes: THREESceneChanges` is informational: `transforms` counts changed mesh
matrices, `membership` reports mesh membership changes, `content` reports mesh
structure, geometry deformation or material changes, and `lights` /
`background` report their edits.
Nothing needs to be forwarded to the renderer. Material edits are converted
and versioned automatically; Three.js `material.needsUpdate` is not required
for color or roughness edits.

After editing attribute/index arrays, set the edited Three.js attribute's
`needsUpdate = true` (for an interleaved attribute, set
`attribute.data.needsUpdate = true`). The sync checks the identities and
versions of position, normal, tangent, uv, uv1 and index buffers, replacing
converted geometry when they change. Deforming meshes instead update position,
normal and tangent arrays in place when only deformation inputs change. After
editing texture pixels, set
`threeTexture.needsUpdate = true`; the existing MuTracer Texture is refreshed in
place. Texture image and UV metadata assignments are also detected.

```ts
geometry.attributes.position.setX(0, 0.5);
geometry.attributes.position.needsUpdate = true;
texture.needsUpdate = true; // after changing its canvas or pixel data
sync.update();
```

`fromTHREEScene(threeScene, options?)` is a one-shot conversion: every call
creates fresh MuTracer objects. Use it for static setup. Both APIs accept an
optional `onMeshConverted(mesh, source, group, groupIndex)` callback (default:
none); the sync calls it for each visible group and expanded instance on every
update.
Call `sync.dispose()` when finished to release its caches. Its last scene
remains usable; calling `update()` after disposal throws.

UV-less meshes use cached material variants for automatic triplanar texture and
displacement projection. A UV-bearing mesh keeps the converted source material;
a UV-less mesh uses a variant that changes only the required projection fields.
Explicit procedural material projections take precedence. Instance colors and
automatic projections are combined in the variant key. Source material edits
refresh all used variants, and each update removes unused variants. Rotation
refits instances on both WebGPU and WebGL 2; material edits use incremental
updates on both backends.

`fromTHREECamera(camera)` is cheap; call it every frame. Call
`camera.updateProjectionMatrix()` after changing its aspect or fov.

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

## Skinning and morph targets

The initial conversion and each `sync.update()` evaluate morph targets and
skinning on the CPU. The sync calls `skeleton.update()` itself, so a preceding
Three.js render is unnecessary. Relative and absolute morph targets affect
positions and normals; skinning transforms positions, normals and supplied
tangents in local space. Missing tangents are generated from the deformed
positions, normals and UVs. The mesh's world transform remains an instance
transform.

Each deforming source mesh owns its MuTracer geometry, even when several
SkinnedMesh objects share a Three.js BufferGeometry. Material groups own
separate geometries, while deformation is calculated once per source mesh
and copied to each group. These geometries use `dynamic = true` and the
built-in binary BLAS; see [BVH animation](./bvh.md#animation).

Pose, binding matrices, morph weights and attribute versions are compared to
the preceding update. An unchanged pose retains the arrays and geometry
version. A changed pose updates the arrays in place and versions the geometry.
Rendering then uploads only the changed geometry and BLAS regions and refits
its instances on both backends. CPU deformation cost grows with vertices and
bone influences; repeated groups also add copying and tangent-generation cost.
Displacement or geometry simplification requires full geometry preparation.

Try the procedural [animation example](../examples/animation.html). Pause the
animation to accumulate samples; changing a pose restarts accumulation.

## Instanced meshes

`InstancedMesh.count` expands to that many MuTracer meshes per material group.
Instances share converted geometry and its BLAS. Each world matrix is
`source.matrixWorld * instanceMatrix[i]`. Editing instance matrices and setting
`instanceMatrix.needsUpdate = true` updates retained matrix arrays; rendering
refits the affected TLAS instances without merging geometry.

Changing `count` retains the existing prefix and adds or removes only the
tail. Both backends rebuild TLAS and instance data while retaining resident
vertices and BLASes. This also handles removal of every instance and later
restoration. Introducing geometry that has never been prepared, displacement,
simplification or geometry-dependent multi-material vertex indices requires
full mesh preparation instead.

`instanceColor` multiplies `baseColor`, including textured color. For an unlit
MeshBasicMaterial it also multiplies the converted `emissionColor`. After
editing colors, set `instanceColor.needsUpdate = true`. Materials are cached
by source material and exact RGB values: repeated colors share one variant,
while N distinct colors can add N materials per source material. Source edits
refresh every cached variant. Historical colors remain cached until
`sync.dispose()`, so frequently inventing new colors increases memory use.
A color switch updates instance material indices and, when needed, material
buffers and the texture atlas; it does not duplicate vertex data.

## `userData` keys

Renderer-specific settings without a Three.js equivalent:

| Key | On | Description |
| --- | --- | --- |
| `mutracerShadowCatcher: true` | material | Shadow-catcher ground |
| `mutracerOpenPBR: { ... }` | material | OpenPBR inputs without a Three.js equivalent: `baseWeight`, `baseDiffuseRoughness`, `specularWeight`, `specularColor`, `coat*`, `fuzz*`, `thinFilm*`, `thinWalled`, `subsurface*`, `transmissionScatter*`, `transmissionDispersion*` |
| `mutracerBevelSize` | material | Shader bevel radius |
| `mutracerUvProjection`, `mutracerUvScale`, `mutracerUvReferenceLength` | material | Procedural UV projection |
| `mutracerDisplacementMode`, `mutracerDisplacement*` | material | Displacement settings, same names as the `OpenPBRMaterial` fields |
| `mutracerThinFilmMap` | material | Thin-film thickness texture |
| `mutracerMeshoptSimplificationRatio` | mesh | Simplify geometry before rendering (0–1) |
| `mutracerRadius` | point / spot light | Emitter radius |
| `mutracerIesProfile`, `mutracerIesRotation` | spot light | `IESProfile` instance and its rotation |
| `mutracerGroundedSkybox: { texture, height, radius, groundHeight?, center? }` | scene | Grounded skybox background |
| `mutracerHiddenBackground: true` | scene | Transparent background while keeping environment lighting |

## glTF without Three.js

`loadGLTF(url)` is a minimal built-in loader for glTF 2.0. It is kept for
dependency-free use; prefer `GLTFLoader` + `fromTHREEScene` for full glTF
extension support.

For vertex attribute edits that preserve indices and `materialIndex`, call
`Geometry.markVerticesUpdated()` to reuse topology and upload only vertex data.
`markUpdated()` also advances the read-only `topologyVersion` (initially `0`)
and remains the notification for index or material-index edits.
