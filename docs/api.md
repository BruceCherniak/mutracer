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
| `autoExposure` | `false` | Histogram auto exposure (WebGPU) |
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

**Callbacks**

- `onSampleRendered(sampleCount, isFirstFrame, frameTime)` runs after samples
  were added.

### Methods

| Method | Description |
| --- | --- |
| `render(scene, camera, forceOutput?)` | Adds samples; returns a [status](#status-codes). Call once per frame |
| `setSize(width, height)` | Resizes the canvas drawing buffer and targets, in pixels |
| `getSize()` | `{ width, height }` |
| `setDenoiser(options?)` | Attaches the built-in JNLM filter or an OIDN network (WebGPU only); `false`/`null` removes it. See [denoising](./denoising.md) |
| `prepareScene(scene, options?)` | Builds missing static BLASes for a scene or `Mesh[]`. `rebuild` (default `false`) replaces existing ones; `onProgress(fraction)` (default none). Resolves to `{ geometryCount, bvhTimeMs }`. Does not compile shaders or render; see [BVH](./bvh.md#what-preparescene-completes) |
| `renderOfflineFrame(scene, camera, options)` | Renders a finished frame; see below |
| `restartSamples()` | Discards the accumulation |
| `getTotalSamplesRendered()` | Accumulated spp |
| `getRawOutput()` | `Promise<{ width, height, data: Float32Array }>` linear RGBA, top row first |
| `readDepthSamples({ x, y, size })` | Asynchronously queries a 7×7 grid of GPU depths after `render()`; see [depth sampling](#depth-sampling) |
| `prepareForExport()` | Redraws post-processing before `canvas.toBlob()` / `toDataURL()` |
| `isUsingWebGPU()` | Active backend |
| `getDiagnostics()` | Backend, adapter, shader compilation, BVH, light sampling and timing details |
| `getGPUDeviceAndAdapter()` | Initializes and returns the WebGPU device/adapter |
| `dispose()` | Releases GPU resources, BVH Workers and the denoiser; cancels pending BVH preparation |

`render()` detects scene edits itself, except material, texture and geometry
data edits, which need `markUpdated()` or `markVerticesUpdated()`; see
[scene updates](./updates.md). An unchanged scene keeps accumulating.

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

## Status codes

`render()` returns one of:

| Constant | Value | Meaning |
| --- | --- | --- |
| `RENDER_STATUS_PREPARING` | 6 | Device initializing or BVHs building |
| `RENDER_STATUS_COMPILING_SHADER` | 1 | Pipelines compiling; no samples added |
| `RENDER_STATUS_RENDERING` | 2 | Samples added; `maxSamples` not reached |
| `RENDER_STATUS_DENOISING` | 3 | `maxSamples` reached; the denoiser is running |
| `RENDER_STATUS_FINISHED` | 4 | Image complete (and denoised if enabled) |
| `RENDER_STATUS_ERROR` | 5 | Failed; see the console and `getDiagnostics()` |
| `RENDER_STATUS_UNKNOWN` | 0 | Never returned; an initial value for callers |

## Scene types

| Export | Description |
| --- | --- |
| `Scene` | `{ meshes, lights, background?, overlay? }`; see below |
| `Mesh` | `new Mesh(geometry, material \| material[])`, `matrixWorld` |
| `Geometry`, `GeometryAttribute` | Triangle data: `position`, `normal`, `indices`, optional `uv`, `uv1`, `tangent`, `color`, `materialIndex`; `dynamic` (default `false`) for [deforming geometry](./updates.md#dynamic-geometry) |
| `OpenPBRMaterial` | See [materials](./materials.md) |
| `Texture` | Image, canvas or `{ data, width, height }`; 8-bit is sRGB, float is linear |
| `Camera` | `'perspective'` or `'orthographic'`; `Camera.lookAt(camera, eye, target, up?)`; depth of field with `fStop`, `focusDistance`, `sensorHeight`, `metersPerUnit` ([details](./getting-started.md#depth-of-field)) |
| `RectLight`, `SphereLight`, `SpotLight`, `DirectionalLight`, `EnvironmentLight`, `AmbientLight` | Lights |
| `IESProfile`, `parseIESProfile(text)` | Photometric profiles for `SpotLight` |
| `SceneBackground` | `[r, g, b, a]`, `Texture` or `GroundedSkyboxBackground` |

`scene.overlay` is an optional image composited over the final frame:
`{ image, x, y, width, height }` in canvas pixels, where `image` is an
`HTMLImageElement`, an `HTMLCanvasElement` or RGBA8 `{ data, width, height }`.

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
| `THREESceneSync` | Keeps a `THREE.Scene` in sync: `new THREESceneSync(threeScene, options?)` once, `sync.update()` before rendering `sync.scene`, `dispose()` when done; see [Three.js](./threejs.md) |
| `fromTHREECamera(camera, options?)` | Converts a Three.js camera; call each frame alongside `THREESceneSync`. Reads `focus` and the film height; `FromTHREECameraOptions` sets `fStop` (default `0`), `focusDistance` and `metersPerUnit` (default `1`) |
| `fromTHREEScene` | One-shot Three.js scene conversion; every call creates fresh MuTracer objects |
| `THREESceneChanges` | Informational result of `update()`: `transforms`, `membership`, `content`, `lights`, `background`; no forwarding to Renderer needed |
| `FromTHREESceneOptions` | Optional `onMeshConverted(mesh, source, group, groupIndex)` callback; default: none |
| `loadGLTF(url)` | Minimal built-in glTF 2.0 loader; prefer Three.js `GLTFLoader` + `THREESceneSync` |
| `CameraViewControl` | Orbit/pan/zoom controller for a MuTracer `Camera` |
| `VERSION` | Library version |

`@meimu/mutracer/oidn` exposes lower-level OIDN loading (`initializeOIDN`,
`initializeOIDNFromURL`, `DEFAULT_OIDN_WEIGHTS_BASE_URL`) for custom denoiser
setups.
