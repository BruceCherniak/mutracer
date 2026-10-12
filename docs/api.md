# API reference

Exports come from `@meimu/mutracer`; declarations carry TSDoc and defaults.
See [progressive rendering](./progressive-rendering.md) for complete examples.

## Engine

`new Engine({canvas?, backend?, validateUpdates?})` owns the device and one GPU
scene. `scene` and `camera` default to undefined. Assign them and call
`update()` to commit edits before rendering; see [updates](./updates.md).

| Setting | Default | Meaning |
| --- | --- | --- |
| `canvas` | new canvas | Default `engine.display.canvas` |
| `backend` | `'auto'` | Automatic WebGPU/WebGL selection; `'webgpu'` requires WebGPU; `'webgl'` forces WebGL 2 |
| `validateUpdates` | development build | Warn about missing material notifications |
| `bvhBuilder` | `'builtin'` | JavaScript or `'tinybvh'` WebAssembly |
| `bvhWorkerCount` | `'auto'` | Hardware concurrency minus one, clamped 1–4; or positive integer |
| `bvhLayout` | `'bvh2'` | Static TinyBVH layout; see [BVH](./bvh.md) |
| `bvhSpatialSplits` | `false` | TinyBVH spatial splits |
| `textureAtlasBudgetBytes` | 384 MiB | Material texture budget |

| Method / property | Meaning |
| --- | --- |
| `update(): boolean` | Sole scene/camera edit detection point; returns whether inputs changed |
| `prepare(scene, {onProgress?, signal?})` | Optional CPU preparation for a future scene; options default undefined |
| `init()` / `info` | Shared initialization promise and `EngineInfo`; info initially undefined |
| `backend` / `device` | Actual backend; device undefined before init and on WebGL |
| `lastError` | Most recent synchronous engine/render error; initially undefined |
| `getDiagnostics()` | Device, scene, compilation, timing, resident-target diagnostics; available after init or CPU preparation |
| `readDepthSamples(area)` | Depth query using the committed engine camera; see [depth sampling](#depth-sampling) |
| `on(name, listener)` | Subscribe; returns unsubscribe |
| `dispose()` | Release renders, GPU resources, Workers and owned denoisers |

`init()` is optional: `update()` and `refine()` initialize lazily. Concurrent
calls share a promise. `EngineInfo` includes backend, adapterName, optional
webgpuFallbackReason and limits for texture layers/dimensions.
Events are `progress` (`{stage: 'device' | 'bvh' | 'shaders', progress}`),
`error` (`Error`), and `devicelost` (`{reason, recovering}`). Each error object
is reported once; console errors are deduplicated by message. Invalid light
values are clamped and reported while rendering continues.

## Render

`new Render(engine, options?)` creates one independent accumulation. All renders
use the engine's committed scene/camera. Options are mutable except fixed
constructor dimensions. Image-quality changes restart only this render;
budget and display changes retain samples.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxSamples` | `2048` | Complete sample budget |
| `bounces` / `clamping` | `3` / `0` | Path depth / per-sample radiance clamp; 0 disables clamping |
| `samplingPattern` | `'sobol'` | Sobol, ZSobol or random; see [sampling](./sampling.md) |
| `directLightCandidates` | `4` | WebGPU light candidates, clamped 1–16; ignored on WebGL |
| `bevel` / `bevelSamples` | `true` / `8` | Bevel shading / probes, clamped 1–32 |
| `dispersionWavelengths` | `3` | 3 wavelengths, or one randomly chosen wavelength |
| `alphaBlendStrategy` | `'stochastic'` | WebGPU primary BLEND policy; ignored on WebGL |
| `transmissiveOutputAlphaMin` | `1` | Path-depth alpha rule over transparent backgrounds; changes restart this render |
| `resolutionScale` | `1` | Relative to display canvas; exclusive with fixed width/height |
| `width` / `height` | undefined | Paired fixed constructor dimensions; getters report actual output dimensions |
| `adaptiveResolution` | `false` | `{targetFrameMs, minScale}` for scale-based renders; both required, positive, minScale ≤ resolutionScale |
| `timeBudgetMs` / `maxTiles` | `21` / `Infinity` | Tile time budget / tiles per call |
| `allowMultipleSamplesPerFrame` | `false` | Add multiple samples when time permits |
| `fallback` | `null` | Single-level Render on the same engine |
| `denoiser` | `null` | Per-render configuration; see [denoising](./denoising.md) |

| Method / property | Meaning |
| --- | --- |
| `refine()` | Trace within this render's budget; returns status |
| `converge(options)` | Deterministic offline image; see below |
| `readPixels(kind = 'hdr')` | Read this render; see [pixel outputs](#pixel-outputs) |
| `samples` | Complete samples since restart; stale engine inputs report 0 |
| `converged` | `samples >= maxSamples`, independently of filtering |
| `status` | Preparing, compiling, converging, denoising, finished or error |
| `restart()` | Discard this accumulation |
| `dispose()` | Release this render and its denoiser lease |

`refine()` returns `'preparing'` during device/BVH setup and `'compiling'`
during shader compilation. Intermediate progressive denoising stays
`'converging'`; final denoising reports `'denoising'`. `'finished'` includes
completed filtering. Synchronous execution failures return `'error'` and set
engine.lastError. Invalid lifecycle operations (disposed render or refine during
converge) throw.

A fallback gets one sample when the requested render cannot finish its first
sample within budget and the fallback has no current complete image. A ready
fallback is not traced again. Fallback chains and cycles are rejected.

### converge(options)

| Option | Default | Meaning |
| --- | --- | --- |
| `samples` | required | Fixed spp, or adaptive cap |
| `camera` | committed camera | Copied override for this call; does not change engine.camera |
| `samplesPerBatch` | `8` | Samples per submission |
| `targetBatchTimeMs` | undefined | Adapt batch sizes on WebGPU |
| `adaptiveSampling` | undefined | Two-stage variance allocation on WebGPU; WebGL falls back to fixed spp |
| `sampleSequenceOffset` | `0` | Sequence base; disjoint ranges for independent frames |
| `previewIntervalMs` | undefined | Minimum delay between intermediate resolved images; never implicitly presents |
| `onProgress` | undefined | `{stage: 'pilot' | 'final' | 'denoising', samples, targetSamples}` |
| `signal` | undefined | Cancellation signal |
| `timeoutMs` | `600000` | Timeout per stage |

Resolves `{samples, averageSamplesPerPixel, pilotSamples, adaptiveSampling,
varianceHistory?}` after filtering. It rejects if engine input revisions change.
The same render cannot refine concurrently; other renders remain usable.

## Display

Use `engine.display`; creation of additional displays is outside this API.
`setSize(width, height)` changes canvas pixels. Scale-based renders resize on
their next refine; fixed renders retain their dimensions.
`present(render)` only presents: it returns the render or its ready fallback,
or undefined without changing the canvas when neither is ready.
`toBlob(render, {type?, quality?})` composes that render at its actual dimensions,
without resizing or changing the current canvas. MIME defaults to image/png;
quality defaults to the browser encoder value.

| Setting | Default |
| --- | --- |
| `toneMapping` | `'agx'` (`aces`, `cineon`, `reinhard`, `linear` also supported) |
| `toneMappingExposure`, `contrast`, `saturation` | `1` |
| `temperature`, `tint`, `vignette` | `0` |
| `bloomIntensity`, `bloomThreshold`, `bloomRadius` | `0`, `1`, `0.6` |
| `hdrOutputEnabled` | `false`; WebGPU only |
| `channel: DisplayChannel` | `'final'`; also albedo, normal, shadow, shadowCatcher |
| `shadowCatcherColor`, `shadowCatcherAlpha` | `[0, 0, 0]`, `1` |

All display settings apply at composition and retain accumulated samples.

### Pixel outputs

`readPixels(kind = 'hdr')` returns `{ width, height, data: Float32Array }`,
RGBA with the top row first. Dimensions describe the internal render texture,
which WebGPU rounds up to multiples of 16. Before a pipeline exists, it returns an empty image.

| Kind | Values |
| --- | --- |
| `hdr` | Original linear HDR samples, unchanged by denoising |
| `denoised` | Native completed denoiser output: WebGPU normally display-linear after composition/tone mapping; WebGL JNLM after tone mapping and display encoding |
| `albedo` | Native linear albedo guide and coverage alpha |
| `normal` | Native normal guide: RGB encoded as `normal * 0.5 + 0.5`, alpha indicates valid surface data |

On WebGPU, the optional OIDN alpha postfilter operates on display colors;
its final native output is also display encoded. Readback preserves these
existing pipeline semantics. If no denoiser is attached or denoising has not
completed, `denoised` returns `hdr` and warns once per render. The method
makes a CPU copy and can be costly; avoid calling it every animation frame.

### Depth sampling

After rendering the current scene and camera, call
`await engine.readDepthSamples({ x: 0.5, y: 0.5, size: 0.07 })`.
The result is a `Float32Array` of 49 depths, in row order from the top left,
including the area's edges. It can be used for area autofocus without CPU
mesh traversal or reading a full-frame image.

`x` and `y` specify the center in viewport coordinates (0..1 from the top
left). `size` is the square's half height as a fraction of viewport height;
`0` samples a single point. All three fields are required. Depth is measured
along the camera's forward axis in scene units, independent of pixel jitter
and depth of field. Invisible shadow catchers and zero-opacity surfaces are
skipped; glass and partially transparent surfaces use their front surface.

Missed and out-of-viewport samples are `0`. Before GPU scene preparation
completes, or while another depth query is in flight, the result is
`undefined`; retry after a later rendered frame. Queries are asynchronous on
WebGPU and WebGL 2 and do not change accumulated rendering samples. Callers
should discard results when their scene, camera or sampling area changes
while a query is pending. GPU failures reject the promise.


## Scene types

Public spatial values use `Vec2` (`[number, number] | Float32Array`), `Vec3` (`[number, number, number] | Float32Array`) and `Mat4` (`Float32Array | number[]`, column-major, 16 elements), exported from the main entry.

| Export | Description |
| --- | --- |
| `Scene` | `{ meshes, lights, background? }`; see below |
| `Mesh` | `new Mesh(geometry, material \| material[])`, `transform` |
| `Geometry`, `GeometryAttribute` | Triangle data: required `position`; optional `normal` and `indices` are generated at construction; `vertexCount` / `triangleCount` getters; optional `uv`, `uv1`, `tangent`, `color`, `materialIndex` (raw per-vertex indices, itemSize 1; all three corners of each triangle must match; invalid indices fall back to material 0 with one warning); `dynamic` (default `false`) for [deforming geometry](./updates.md#dynamic-geometry) |
| `OpenPBRMaterial` | `new OpenPBRMaterial(params?)`; see [materials](./materials.md) |
| `Texture` | Image, canvas or `{ data, width, height }`; 8-bit is sRGB, float is linear |
| `Camera` | `new Camera({ projection: 'perspective', ... })` or orthographic; `position`, `lookAt()`, `copy(source)`, `clone()`; aspect defaults to automatic; depth of field with `fStop`, `focusDistance`, `sensorHeight`, `metersPerUnit` ([details](./getting-started.md#depth-of-field)) |
| `RectLight`, `SphereLight`, `SpotLight`, `DirectionalLight`, `EnvironmentLight`, `AmbientLight` | Parameter-object constructors; analytic lights use `transform`, `position`, `lookAt()` and rigid axes. See [lights](./getting-started.md#lights) |
| `IESProfile`, `parseIESProfile(text)` | Photometric profiles for `SpotLight` |
| `SceneBackground` | `[r, g, b, a]`, `Texture` or `GroundedSkyboxBackground` |

`Geometry`, `Texture` and `OpenPBRMaterial` expose `version` (initially `0`)
and `markUpdated(): this`. `Geometry` also has the read-only `topologyVersion`
(initially `0`) and `markVerticesUpdated(): this`, which advances only
`version`. See [scene updates](./updates.md) for when to call each.

## Helpers

| Export | Description |
| --- | --- |
| `createPlaneGeometry`, `createCubeGeometry`, `createSphereGeometry`, `createCurvePlaneGeometry` | Procedural geometry (plane is 2×2 in XZ, cube and sphere span −1..1) |
| `generateVertexNormals`, `generateVertexTangents` | Attribute generation |
| `computeMeshesBoundingBox(meshes)` | World-space bounds |
| `loadRGBE(url)`, `parseRGBE(buffer)` | Radiance `.hdr` → float `Texture` |
| `THREESceneSync` | Keeps a `THREE.Scene` in sync: `new THREESceneSync(threeScene, options?)` once, `sync.update(): void` before rendering `sync.scene`, `dispose()` when done; see [Three.js](./threejs.md) |
| `fromTHREECamera(camera, options?)` | Converts a Three.js camera; call each frame alongside `THREESceneSync`. Reads `focus` and the film height; `FromTHREECameraOptions` sets `fStop` (default `0`), `focusDistance` and `metersPerUnit` (default `1`) |
| `fromTHREEScene` | One-shot Three.js scene conversion; every call creates fresh MuTracer objects |
| `FromTHREESceneOptions` | Optional `onMeshConverted(mesh, source, group, groupIndex)` callback; default: none |
| `CameraViewControl` | Orbit/pan/zoom controller for a MuTracer `Camera` |
| `VERSION` | Library version |

`@meimu/mutracer/oidn` exposes lower-level OIDN loading (`initializeOIDN`,
`initializeOIDNFromURL`, `DEFAULT_OIDN_WEIGHTS_BASE_URL`) for custom denoiser
setups.

## Implementation notes

BVH caches, light packing helpers and material-weight packing are renderer internals. `CameraViewControl` initializes itself at construction. Texture upload notifications use `markUpdated()` and `version`.
