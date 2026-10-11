# Getting started

## Concepts

MuTracer renders a plain **scene description** with a **camera**:

```ts
interface Scene {
  meshes: Mesh[];          // geometry + one OpenPBRMaterial per group
  lights: SceneLight[];    // analytic lights, environment and ambient light
  background?: ColorRGBA | Texture | GroundedSkyboxBackground;
}
```

- `Mesh(geometry, material)` places a `Geometry` in the world with
  `mesh.matrixWorld` (a column-major `mat4`, compatible with `gl-matrix`).
- `Geometry` holds indexed or non-indexed triangle attributes. Use the helpers
  `createPlaneGeometry`, `createCubeGeometry`, `createSphereGeometry` or build
  one from arrays (see below).
- Materials are `OpenPBRMaterial` instances. See [materials](./materials.md).
- Units are arbitrary but consistent; light intensities are in radiometric
  units relative to them.

The `Renderer` accumulates samples progressively. Call `render()` once per
animation frame; it returns a [status](./api.md#status-codes).

## A minimal render loop

```ts
import { Camera, Renderer, RENDER_STATUS_FINISHED } from '@meimu/mutracer';

const renderer = new Renderer({ canvas });
renderer.maxSamples = 1024;
renderer.bounces = 5;

function resize() {
  const ratio = Math.min(devicePixelRatio, 2);
  renderer.setSize(canvas.clientWidth * ratio, canvas.clientHeight * ratio);
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
}

function frame() {
  const status = renderer.render(scene, camera);
  if (status === RENDER_STATUS_FINISHED) {
    // The image converged. render() keeps returning FINISHED cheaply.
  }
  requestAnimationFrame(frame);
}
resize();
frame();
```

`new Renderer()` picks WebGPU when available and WebGL 2 otherwise. The first
calls return `RENDER_STATUS_PREPARING` (device setup, BVH builds) and
`RENDER_STATUS_COMPILING_SHADER`; keep calling `render()`. BVHs build
automatically; for a loading screen, see
[BVH preparation flows](./bvh.md#choose-a-preparation-flow).

## Geometry from arrays

```ts
import { Geometry, GeometryAttribute, generateVertexNormals } from '@meimu/mutracer';

const geometry = new Geometry({
  position: new GeometryAttribute(new Float32Array(positions), 3),
  indices: new GeometryAttribute(new Uint32Array(indices), 1),
  uv: new GeometryAttribute(new Float32Array(uvs), 2) // optional
});
generateVertexNormals(geometry);
```

For several materials on one geometry, pass an array of materials to `Mesh`
and set `geometry.materialIndex` to an `Int32Array` attribute with one index
into `mesh.materials` per vertex.

## Cameras

```ts
const camera = new Camera('perspective', 45 /* vertical fov */, aspect, 0.1, 100);
Camera.lookAt(camera, [0, 2, 6], [0, 0, 0]);
```

`CameraViewControl` provides orbit/pan/zoom for a MuTracer camera. With Three.js,
use its controls and convert with `fromTHREECamera` each frame.

### Depth of field

Depth of field uses a thin lens described in photographic terms:

```ts
camera.fStop = 2.8;          // f-number; 0 (default) disables depth of field
camera.focusDistance = 6;    // lens to focus plane, along the view direction
camera.sensorHeight = 24;    // mm; with fov it sets the focal length
camera.metersPerUnit = 1;    // scene unit length in metres (glTF: 1)
```

The lens radius is `focalLength / (2 * fStop)`, where the focal length follows
from `sensorHeight`, `fov` and `zoom`. `Camera.getFocalLength(camera)` returns
it in millimetres and `Camera.getApertureRadius(camera)` returns the lens radius
in scene units. A narrower field of view or a lower f-number blurs more, as on a
real camera.

`metersPerUnit` converts the lens size to scene units. When a scene is modelled
in centimetres set it to `0.01`. For a miniature look, treat the scene as
smaller than it is (`0.1` turns a 2 m object into a 20 cm one). Orthographic
cameras have no depth of field.

## Lights

| Class | Constructor | Notes |
| --- | --- | --- |
| `RectLight` | `(size, color, intensity)` | One-sided, emits along local -Z of `matrixWorld` |
| `SphereLight` | `(position, color, intensity, radius)` | `radius = 0` is a point light |
| `SpotLight` | `(position, direction, color, intensity, radius, innerAngle, outerAngle, range, iesProfile?, iesRotation?)` | Angles in degrees; `parseIESProfile(text)` for IES files |
| `DirectionalLight` | `(position, color, intensity)` | Direction from `position` towards the origin |
| `EnvironmentLight` | `(texture)` | Equirectangular map; importance sampled |
| `AmbientLight` | `(color, intensity)` | Uniform environment |

Load `.hdr` environments with `await loadRGBE(url)`, which resolves to a
float `Texture`. Emissive materials (`emissionLuminance > 0`) also act as
lights.

## Backgrounds

- omitted: camera rays show the environment light;
- `[r, g, b, a]`: a linear color. `[0, 0, 0, 0]` gives a transparent canvas;
  combine with `shadowCatcher` materials to composite over a web page;
- a `Texture`: an equirectangular background independent of the lighting;
- `{ type: 'GroundedSkybox', map, height, radius }`: projects the environment
  onto a ground plane.

## Updating the scene

Keep the same scene and edit it in place. Scene membership, transforms,
resource references, lights and backgrounds are detected automatically. Three
edits need a notification:

```ts
material.specularRoughness = 0.6;
material.markUpdated();               // material parameters

texture.markUpdated();                // texture pixels or UV-array elements

geometry.markVerticesUpdated();       // vertex attributes only
geometry.markUpdated();               // indices, materialIndex or other geometry data
```

See [scene updates](./updates.md) for the full table, vertex animation and
update costs. With Three.js, call `sync.update()` before each render instead;
see [Three.js](./threejs.md).

## Exporting an image

For a final-quality still, use `renderOfflineFrame`, which renders a fixed
number of samples (optionally adaptive), denoises when a denoiser is set, and
resolves when finished:

```ts
await renderer.renderOfflineFrame(scene, camera, {
  samples: 1024,
  onProgress: ({ stage, samples, targetSamples }) => console.log(stage, samples, targetSamples)
});
renderer.prepareForExport();
canvas.toBlob((blob) => { /* save */ }, 'image/png');
```

`await renderer.getRawOutput()` returns the linear HDR image as
`{ width, height, data: Float32Array }` (RGBA, top row first).

## Cleanup

Call `renderer.dispose()` to release GPU resources, BVH Workers and the denoiser. With
Three.js, also call `sync.dispose()` to release the conversion caches.

## Bundler notes

Vite development prebundles dependencies and can relocate asset URLs. Exclude
MuTracer so the bundled OIDN standard/small weights and the optional TinyBVH
wasm load from the package:

```ts
export default defineConfig({
  optimizeDeps: { exclude: ['@meimu/mutracer'] }
});
```

Vite production builds and webpack 5 copy these assets without extra
configuration. With bundlers that do not support asset URLs, self-host the
OIDN weights with `weightsBaseUrl` (see [denoising](./denoising.md#hosting-the-weights)).
