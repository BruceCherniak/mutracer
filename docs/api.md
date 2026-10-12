# API reference

Everything is exported from `@meimu/mutracer`. Type declarations carry TSDoc with
defaults for every option; this page summarizes them.

## `Renderer`

```ts
new Renderer(params?: RendererParams)
```

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `canvas` | `HTMLCanvasElement` | new canvas | Canvas to draw into (`renderer.canvas`) |
| `preferWebGPU` | `boolean` | `true` | `false` forces the WebGL 2 backend |
| `denoiser` | `boolean \| DenoiserOptions` | `false` | Same as calling `setDenoiser()` |
| `validateUpdates` | `boolean` | development build | Warn once for missing material notifications; at most 200 checks per render. See [updates](./updates.md#checking-missing-material-notifications) |
| `preserveDrawingBuffer` | `boolean` | `true` | WebGL 2; needed to read the canvas back |

### Properties

Properties are plain fields read on the next `render()`. Changing one that
affects the image restarts accumulation.

**Sampling and integration**

| Property | Default | Description |
| --- | --- | --- |
| `maxSamples` | `2048` | Samples per pixel before the image is finished |
| `bounces` | `3` | Maximum path depth |
| `clamping` | `0` | Per-sample radiance clamp; `0` is unbiased |
| `directLightCandidates` | `4` | Light candidates resampled per next-event estimate (WebGPU, 1–16) |
| `bevelSamples` | `8` | Probes per sample for `OpenPBRMaterial.bevelSize` (1–32) |
| `samplingPattern` | `'sobol'` | `'sobol'`, `'zsobol'` or `'random'`; see [sampling](./sampling.md) |
| `alphaBlendStrategy` | `'stochastic'` | `'stochastic'` or `'deterministic-source-over'` for glTF `BLEND` materials (WebGPU) |
| `bvhBuilder` | `'builtin'` | `'builtin'` (JavaScript) or `'tinybvh'` (WebAssembly); see [BVH](./bvh.md) |
| `bvhWorkerCount` | `'auto'` | Maximum static BLAS Workers per renderer: `'auto'` selects 1–4, or set a positive safe integer; see [BVH](./bvh.md#configure-parallel-construction) |
| `bvhLayout` | `'bvh2'` | Static TinyBVH layout: `'bvh2'`, `'bvh4'`, `'bvh-gpu'` or `'cwbvh'` |
| `bvhSpatialSplits` | `false` | With `'tinybvh'`, build SBVHs: slower builds, sometimes faster rendering |
| `textureAtlasBudgetBytes` | 384 MiB | Texture atlas memory budget; larger textures are downscaled |

**Responsiveness**

| Property | Default | Description |
| --- | --- | --- |
| `interactivePreview` | `true` | Cheaper preview while the camera or scene changes |
| `previewResolutionScale` | `0.5` | Maximum preview resolution scale (0.25–1) |
| `previewBounces` | `2` | Path depth during preview |
| `previewIdleDelayMs` | `150` | Idle time before full quality resumes |
| `maxTimePerTile` | `21` | Target GPU milliseconds per tile |
| `maxTimePreview` | `20` | Target GPU milliseconds per preview frame |
| `maxTiles` | `Infinity` | Upper bound on tiles per frame |
| `allowMultipleSamplesPerFrame` | `false` | Render several samples per `render()` when the GPU has time |

**Display** (post-processing only; does not restart accumulation)

| Property | Default | Description |
| --- | --- | --- |
| `toneMapping` | `'agx'` | `'agx'`, `'aces'`, `'cineon'`, `'reinhard'`, `'linear'` |
| `toneMappingExposure` | `1` | Linear exposure multiplier |
| `contrast`, `saturation` | `1` | Color grading |
| `temperature`, `tint` | `0` | White balance, roughly −1 to 1 |
| `vignette` | `0` | Vignette strength |
| `bloomIntensity` | `0` | `0` disables bloom |
| `bloomThreshold` | `1` | Luminance threshold for bloom |
| `bloomRadius` | `0.6` | Bloom radius (0–1) |
| `hdrOutputEnabled` | `false` | Extended-range output on HDR displays (WebGPU) |
| `output` | `'final'` | `'final'`, `'albedo'`, `'normal'`, `'shadow'`, `'shadowCatcher'` |
| `shadowCatcherColor` | `[0, 0, 0]` | Shadow color on shadow-catcher materials |
| `shadowCatcherAlpha` | `1` | Shadow opacity on shadow catchers |
| `transmissiveOutputAlphaMin` | `1` | Minimum alpha of glass over a transparent background |

**Events**

`renderer.on(name, listener)` supports multiple listeners and returns an unsubscribe function.

| Event | Payload |
| --- | --- |
| `sample` | `{ samples, preview, isFirstFrame, frameTimeMs }` |
| `status` | `{ status, previous }`; emitted only when status changes |
| `progress` | `{ stage: 'device' \| 'bvh' \| 'shaders', progress }`; preparing/compiling only |
| `error` | `Error`; each error object is delivered once |
| `denoised` | `{ samples, final }`; after completed denoising |
| `devicelost` | `{ reason, recovering }` |

### Methods

| Method | Description |
| --- | --- |
| `render(scene, camera)` | Adds samples; returns a [status](#status). Call once per frame |
| `setSize(width, height)` | Resizes the canvas drawing buffer and targets, in pixels |
| `getSize()` | `{ width, height }` |
| `setDenoiser(options?)` | Attaches the built-in JNLM filter or an OIDN network (WebGPU only); `false`/`null` removes it. See [denoising](./denoising.md) |
| `prebuildBVH(scene, options?)` | Optional early static BVH build; resolves void; `onProgress` and `signal` default undefined. Statistics in diagnostics `bvh.lastBuild`; see [BVH](./bvh.md) |
| `renderOfflineFrame(scene, camera, options)` | Renders a finished frame; see below |
| `restartSamples()` | Discards the accumulation |
| `samples` | Accumulated spp; initially 0 |
| `readPixels(kind = 'hdr')` | RGBA float32, top row first; hdr, denoised, albedo or normal; see [pixel outputs](#pixel-outputs) |
| `readDepthSamples({ x, y, size })` | Asynchronously queries a 7×7 grid of GPU depths after `render()`; see [depth sampling](#depth-sampling) |
| `toBlob({ type?, quality? } = {})` | Redraws post-processing, waits for GPU work and encodes a Blob; type defaults image/png, quality undefined |
| `backend` / `device` | Backend (`'webgpu'` / `'webgl'`), initially undefined; device only on WebGPU |
| `getDiagnostics()` | Available after initialization or a BVH build (backend undefined before init); backend, adapter, shader compilation, BVH, light sampling and timing details |
| `init()` / `info` | Initializes once and resolves `RendererInfo`; synchronous info is undefined before completion |
| `dispose()` | Releases GPU resources, BVH Workers and the denoiser; cancels pending BVH preparation |

`await renderer.init()` is optional: `render()` initializes lazily. Concurrent
initializations share one promise. `info` contains `backend`, `adapterName`,
optional `webgpuFallbackReason`, and `limits.maxTextureArrayLayers` /
`limits.maxTextureDimension2D`. Use `backend === 'webgpu'` for OIDN, direct
light candidates, alpha blend strategy, HDR output and offline adaptive
sampling. WebGL ignores those settings; actual HDR presentation is reported
by `getDiagnostics().hdrPresentation.active`.

`render()` detects scene edits itself, except material, texture and geometry
data edits, which need `markUpdated()` or `markVerticesUpdated()`; see
[scene updates](./updates.md). An unchanged scene keeps accumulating.

Synchronous rendering failures return `'error'` without throwing and emit an `error`
event. `lastError` (default `undefined`) only describes a synchronous failure during
the most recent `render()` call. Async denoising and constructor-denoiser failures
are delivered through `error` events and do not set `lastError`. A later render
does not repeat these events. Console errors are deduplicated by message. Invalid
light values are clamped and reported once through `error`, while rendering continues
with `lastError` undefined. Diagnostics include synchronous `lastError` and
`webgpuFallbackReason` messages when applicable.

While-converging intermediate denoise batches report `'converging'`. Only denoising the final image at `maxSamples` reports `'denoising'`; `'finished'` means that final image is ready.

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
completed, `denoised` returns `hdr` and warns once per renderer. The method
makes a CPU copy and can be costly; avoid calling it every animation frame.

### Depth sampling

After rendering the current scene and camera, call
`await renderer.readDepthSamples({ x: 0.5, y: 0.5, size: 0.07 })`.
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

### `renderOfflineFrame(scene, camera, options)`

| Option | Description |
| --- | --- |
| `samples` | Fixed spp, or the cap when `adaptiveSampling` is set |
| `samplesPerBatch` | Samples submitted before yielding to the page |
| `targetBatchTimeMs` | Adapt batch size to this GPU time (WebGPU) |
| `adaptiveSampling` | Two-stage variance-driven allocation (`OfflineAdaptiveSamplingOptions`) |
| `sampleSequenceOffset` | Sequence base; use disjoint ranges per animation frame |
| `previewIntervalMs` | Minimum delay between canvas updates; omit for maximum throughput |
| `onProgress({ stage, samples, targetSamples })` | `stage` is `'pilot'`, `'final'` or `'denoising'` |
| `signal` | `AbortSignal` |
| `timeoutMs` | Per-stage timeout, default 10 minutes |

Resolves to `{ samples, averageSamplesPerPixel, pilotSamples, adaptiveSampling }`.
If a denoiser is set, the result is denoised before the promise resolves.

## Status

`render()` returns one of:

| Status | Meaning |
| --- | --- |
| `'preparing'` | Device initializing or BVHs building; initial status |
| `'compiling'` | Pipelines compiling; no samples added |
| `'converging'` | Samples accumulating toward `maxSamples` |
| `'denoising'` | `maxSamples` reached; final denoising in progress |
| `'finished'` | Image complete, including final denoising |
| `'error'` | Synchronous rendering failed; inspect `lastError` |

Read `renderer.status` for the latest render result (default `'preparing'`).

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
