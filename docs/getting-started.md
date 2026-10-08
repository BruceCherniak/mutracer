# Getting started

## Concepts

ClayPT renders a plain **scene description** with a **camera**:

```ts
interface Scene {
  meshes: Mesh[];          // geometry + one OpenPBRMaterial per group
  lights: SceneLight[];    // analytic lights, environment and ambient light
  background?: ColorRGBA | Texture | GroundedSkyboxBackground;
  meshRevision?: number;   // bump after in-place mesh edits
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
import { Camera, Renderer, RENDER_STATUS_FINISHED } from 'claypt';

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
`RENDER_STATUS_COMPILING_SHADER`; keep calling `render()`.

## Geometry from arrays

```ts
import { Geometry, GeometryAttribute, generateVertexNormals } from 'claypt';

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
camera.aperture = 0.05;      // depth of field, 0 disables
camera.focusDistance = 6;
```

`CameraViewControl` provides orbit/pan/zoom for a ClayPT camera. With Three.js,
use its controls and convert with `fromTHREECamera` each frame.

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
float `Texture`.
Emissive materials (`emissionLuminance > 0`) also act as lights.

## Backgrounds

- omitted: camera rays show the environment light;
- `[r, g, b, a]`: a linear color. `[0, 0, 0, 0]` gives a transparent canvas;
  combine with `shadowCatcher` materials to composite over a web page;
- a `Texture`: an equirectangular background independent of the lighting;
- `{ type: 'GroundedSkybox', map, height, radius }`: projects the environment
  onto a ground plane.

## Updating the scene

The renderer compares references, not contents, so updates are cheap:

| Change | What to do |
| --- | --- |
| Camera moved or changed | Nothing; checked every frame |
| Renderer option changed | Nothing; read on the next `render()` |
| Meshes added or removed | Assign a new `scene.meshes` array |
| Mesh transform, material or texture edited in place | `renderer.markMeshesDirty()` (or `scene.meshRevision++`) |
| Many transforms in an animation (WebGPU) | `renderer.markMeshTransformsDirty(meshes)` refits only those instances |
| Geometry arrays edited | `geometry.markUpdated()` and `renderer.markMeshesDirty()` |
| Texture pixels edited | `texture.markUpdated()` and `renderer.markMeshesDirty()` |
| Light added, removed or edited | Assign a new `scene.lights` array |
| Background changed | Assign a new value |

Any change that affects the image restarts accumulation. While things change,
`interactivePreview` renders a cheaper, lower-resolution image.

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

Call `renderer.dispose()` to release GPU resources and the denoiser.
