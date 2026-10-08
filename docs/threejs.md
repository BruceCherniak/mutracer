# Three.js integration

Build or load a scene with Three.js and render it with ClayPT. Three.js is an
optional peer dependency (`npm install three`).

```ts
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Renderer, fromTHREEScene, fromTHREECamera, type FromTHREEGeometryCache } from 'claypt';

const threeScene = new THREE.Scene();
threeScene.add((await new GLTFLoader().loadAsync('model.glb')).scene);

const renderer = new Renderer({ canvas });
const geometryCache: FromTHREEGeometryCache = new WeakMap();

threeScene.updateMatrixWorld();
let scene = fromTHREEScene(threeScene, { geometryCache });

function frame() {
  renderer.render(scene, fromTHREECamera(threeCamera));
  requestAnimationFrame(frame);
}
frame();
```

## Keeping scenes in sync

`fromTHREEScene` returns a new ClayPT `Scene` each call. Re-convert after
changing the Three.js scene, passing the same `geometryCache`: converted
geometry and its BVH are reused, so a transform-only change only refits the
instances. Do not re-convert every frame when nothing changed.

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
