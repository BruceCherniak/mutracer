# Three.js integration

Build or load a Three.js scene, then bind it and its camera with THREESync.
RenderLoop calls the sync automatically. Three.js is an optional peer dependency
(`npm install three`).

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Engine, RenderLoop, THREESync } from '@meimu/mutracer';
const scene = new THREE.Scene();
scene.add((await new GLTFLoader().loadAsync('model.glb')).scene);
const camera = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, .1, 100);
camera.position.set(0, 2, 6);
const controls = new OrbitControls(camera, canvas);
const engine = new Engine({canvas});
const sync = new THREESync(engine, {scene, camera, controls});
const loop = new RenderLoop(engine, {sync});
loop.start();
```

## Keeping scenes in sync

Edit Three.js transforms, membership, lights, backgrounds and materials directly.
Material edits are converted and versioned automatically; color and roughness
edits do not require `material.needsUpdate`. Buffer and pixel edits need the
usual flags:

| Edit | Flag |
| --- | --- |
| Attribute or index array elements | `attribute.needsUpdate = true` (`attribute.data.needsUpdate` for interleaved) |
| Texture pixels or canvas | `texture.needsUpdate = true` |
| Instance matrices / colors | `instanceMatrix.needsUpdate` / `instanceColor.needsUpdate = true` |

```ts
threeMesh.rotation.y += .01;
threeMaterial.roughness = .6;
geometry.attributes.position.setX(0, .5);
geometry.attributes.position.needsUpdate = true;
// The next loop tick synchronizes and commits these edits.
```

For an application-owned animation frame, update the animation mixer first,
then call `loop.tick()`. With first-layer frame control, call `sync.update()`,
`engine.update()`, `render.refine()` and `engine.display.present(render)` in order.

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
| `mutracerDisplacement*` | material | Displacement settings, same names as the `OpenPBRMaterial` fields; projection scale is `mutracerDisplacementUvProjectionScale` |
| `mutracerThinFilmMap` | material | Thin-film thickness texture |
| `mutracerRadius` | point / spot light | Emitter radius |
| `mutracerIesProfile`, `mutracerIesRotation` | spot light | `IESProfile` instance; rotation becomes local-Z transform rotation |
| `mutracerGroundedSkybox: { texture, height, radius, groundHeight?, center? }` | scene | Grounded skybox background |
| `mutracerHiddenBackground: true` | scene | Transparent background while keeping environment lighting |

Directional and spot lights use their world position and target to build a
MuTracer transform; source rotation alone does not specify their direction.

## Options

`new THREESync(engine, options?)` accepts these optional sources and settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `scene` | undefined | Three.js scene; omitted leaves engine.scene untouched |
| `camera` | undefined | Perspective or orthographic camera; omitted leaves engine.camera untouched |
| `controls` | undefined | Controls with update and start/end events, such as OrbitControls |
| `updateControls` | true | Calls controls.update; false leaves updating to the application |
| `onMeshConverted` | undefined | `(mesh, source, group, groupIndex)` on every visible group/expanded instance during update |

Construction subscribes to control events. The first update converts and writes
sources to the engine. `scene` exposes the retained converted scene, or undefined
when no source was supplied. A camera-only sync preserves a MuTracer-built scene.
`active` covers start/end interaction, camera movement, damping and changing
skinned/morph poses. The damping tail ends when movement and zoom fall below
0.05% of view distance, allowing final refinement in that same tick.

`fromTHREEScene(scene, options?)` and `fromTHREECamera(camera, options?)` remain
available for one-shot conversions. Every scene conversion creates fresh objects.
Call `camera.updateProjectionMatrix()` after changing aspect or fov. A perspective
camera's focus and film height become MuTracer focus distance and sensor height;
pass `{fStop: 2.8}` to `fromTHREECamera` to enable depth of field.

## Caveats

THREESync updates world/bone matrices and retains unchanged meshes, materials,
textures, lights, backgrounds and membership arrays. MuTracer transforms use
Three.js matrixWorld, preserving double precision. Skinning and morphs run on the
CPU, updating retained geometry in place. Other changed buffers replace geometry
and require a [full mesh update](./updates.md#full-mesh-updates).

`sync.dispose()` removes control subscriptions and conversion caches; it leaves
the last converted scene usable. Updating a disposed sync throws. RenderLoop does
not dispose supplied syncs or renders; see [ownership](./progressive-rendering.md#options-and-ownership).

