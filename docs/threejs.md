# Three.js integration

Build or load a scene with Three.js and render it with ClayPT. Three.js is an
optional peer dependency (`npm install three`).

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Renderer, THREESceneSync, fromTHREECamera } from 'claypt';

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
textures stay shared in ClayPT, including within a one-shot conversion.

```ts
threeMesh.rotation.y += 0.01;
threeMaterial.color.setRGB(0.4, 0.2, 0.1);
threeMaterial.roughness = 0.6;
const changes = sync.update();
renderer.render(sync.scene, fromTHREECamera(threeCamera));
```

`changes: THREESceneChanges` is informational: `transforms` counts changed mesh
matrices, `membership` reports mesh membership changes, `content` reports mesh
structure or material changes, and `lights` / `background` report their edits.
Nothing needs to be forwarded to the renderer. Material edits are converted
and versioned automatically; Three.js `material.needsUpdate` is not required
for color or roughness edits.

After editing attribute/index arrays, set the edited Three.js attribute's
`needsUpdate = true` (for an interleaved attribute, set
`attribute.data.needsUpdate = true`). The sync checks the identities and
versions of position, normal, tangent, uv, uv1 and index buffers, replacing
converted geometry when they change. After editing texture pixels, set
`threeTexture.needsUpdate = true`; the existing ClayPT Texture is refreshed in
place. Texture image and UV metadata assignments are also detected.

```ts
geometry.attributes.position.setX(0, 0.5);
geometry.attributes.position.needsUpdate = true;
texture.needsUpdate = true; // after changing its canvas or pixel data
sync.update();
```

`fromTHREEScene(threeScene, options?)` is a one-shot conversion: every call
creates fresh ClayPT objects. Use it for static setup. Both APIs accept an
optional `onMeshConverted(mesh, source, group, groupIndex)` callback (default:
none); the sync calls it for each visible group on every update.
Call `sync.dispose()` when finished to release its caches. Its last scene
remains usable; calling `update()` after disposal throws.

UV-less meshes retain automatic triplanar fallback through `Mesh.uvProjection`
and `Mesh.displacementUvProjection` overrides. These default to inheriting the
material. A shared material can therefore render a UV-bearing mesh with its
UVs and a UV-less mesh with triplanar projection without changing material
identity. Explicit procedural material projections continue to take precedence
in the converter. WebGPU rotation refits instances; WebGL rotation rebuilds
mesh data. Material edits use incremental updates on both backends.

`fromTHREECamera(camera)` is cheap; call it every frame. Call
`camera.updateProjectionMatrix()` after changing its aspect or fov.

## What is converted

| Three.js | ClayPT |
| --- | --- |
| `Mesh` with `MeshStandardMaterial` / `MeshPhysicalMaterial` | `Mesh` + `OpenPBRMaterial` (color, metalness, roughness, maps, normal map, emissive, transmission, attenuation, IOR, clearcoat, sheen, iridescence, anisotropy, alpha) |
| `Mesh` with `MeshBasicMaterial` (glTF `KHR_materials_unlit`) | Unlit emissive material |
| Multi-material groups | One ClayPT mesh per group |
| `DirectionalLight` | `DirectionalLight` |
| `PointLight` | `SphereLight` (radius `userData.clayptRadius`, default 0.25) |
| `SpotLight` | `SpotLight` (radius `userData.clayptRadius`, default 0.01; `penumbra` sets the inner angle) |
| `RectAreaLight` | `RectLight` |
| `AmbientLight` | `AmbientLight` |
| `scene.environment` (equirectangular float `DataTexture`, e.g. from `HDRLoader`/`RGBELoader`) | `EnvironmentLight` |
| `scene.background` color / texture | Background; the environment itself when `background === environment` |

Invisible objects are skipped. Other material types are skipped with a console
warning. `InstancedMesh` instances are not expanded.

## `userData` keys

Renderer-specific settings without a Three.js equivalent:

| Key | On | Description |
| --- | --- | --- |
| `clayptShadowCatcher: true` | material | Shadow-catcher ground |
| `clayptOpenPBR: { ... }` | material | OpenPBR inputs without a Three.js equivalent: `baseWeight`, `baseDiffuseRoughness`, `specularWeight`, `specularColor`, `coat*`, `fuzz*`, `thinFilm*`, `thinWalled`, `subsurface*`, `transmissionScatter*`, `transmissionDispersion*` |
| `clayptBevelSize` | material | Shader bevel radius |
| `clayptUvProjection`, `clayptUvScale`, `clayptUvReferenceLength` | material | Procedural UV projection |
| `clayptDisplacementMode`, `clayptDisplacement*` | material | Displacement settings, same names as the `OpenPBRMaterial` fields |
| `clayptThinFilmMap` | material | Thin-film thickness texture |
| `clayptMeshoptSimplificationRatio` | mesh | Simplify geometry before rendering (0–1) |
| `clayptRadius` | point / spot light | Emitter radius |
| `clayptIesProfile`, `clayptIesRotation` | spot light | `IESProfile` instance and its rotation |
| `clayptGroundedSkybox: { texture, height, radius, groundHeight?, center? }` | scene | Grounded skybox background |
| `clayptHiddenBackground: true` | scene | Transparent background while keeping environment lighting |

## glTF without Three.js

`loadGLTF(url)` is a minimal built-in loader for glTF 2.0. It is kept for
dependency-free use; prefer `GLTFLoader` + `fromTHREEScene` for full glTF
extension support.
