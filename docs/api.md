# API reference

Everything is exported from `claypt`. Type declarations carry TSDoc with
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
| `bvhBuilder` | `'tinybvh'` | `'tinybvh'` (WebAssembly, async) or `'builtin'` (JavaScript, sync) |
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
| `toneMapping` | `'agx'` | `'agx'`, `'aces'`, `'cineon'`, `'reinhard'`, `'linear'`, `'neutral'` (Tony McMapface, WebGPU) |
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
| `setDenoiser(options?)` | Loads and attaches OIDN (WebGPU); `false`/`null` removes it. See [denoising](./denoising.md) |
| `prepareScene(scene \| meshes)` | Builds missing BVHs ahead of time (otherwise done by `render()`) |
| `renderOfflineFrame(scene, camera, options)` | Renders a finished frame; see below |
| `restartSamples()` | Discards the accumulation |
| `getTotalSamplesRendered()` | Accumulated spp |
| `getRawOutput()` | `Promise<{ width, height, data: Float32Array }>` linear RGBA, top row first |
| `prepareForExport()` | Redraws post-processing before `canvas.toBlob()` / `toDataURL()` |
| `isUsingWebGPU()` | Active backend |
| `getDiagnostics()` | Backend, adapter, shader compilation, BVH, light sampling and timing details |
| `getGPUDeviceAndAdapter()` | Initializes and returns the WebGPU device/adapter |
| `dispose()` | Releases GPU resources and the denoiser |

Scene membership, transforms, light parameters and background edits are
detected on each `render()`, even when their arrays are retained. After editing
material parameters, geometry attributes or texture pixels/UV-array elements,
call the edited object's `markUpdated()`. The next render restarts accumulation
and selects the appropriate update path. An unchanged scene keeps accumulating.

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
| `RENDER_STATUS_DENOISING` | 3 | `maxSamples` reached; OIDN running |
| `RENDER_STATUS_FINISHED` | 4 | Image complete (and denoised if enabled) |
| `RENDER_STATUS_ERROR` | 5 | Failed; see the console and `getDiagnostics()` |
| `RENDER_STATUS_UNKNOWN` | 0 | Never returned; an initial value for callers |

## Scene types

| Export | Description |
| --- | --- |
| `Scene` | `{ meshes, lights, background?, overlay? }` |
| `Mesh` | `new Mesh(geometry, material \| material[])`, `matrixWorld`; texture and displacement projection are configured on the material |
| `Geometry`, `GeometryAttribute` | Triangle data: `position`, `normal`, `indices`, optional `uv`, `uv1`, `tangent`, `color`, `materialIndex`; `dynamic` (default `false`) selects the built-in refittable BLAS when `true` |
| `OpenPBRMaterial` | See [materials](./materials.md) |
| `Texture` | Image, canvas or `{ data, width, height }`; 8-bit is sRGB, float is linear |
| `Camera` | `'perspective'` or `'orthographic'`; `Camera.lookAt(camera, eye, target, up?)` |
| `RectLight`, `SphereLight`, `SpotLight`, `DirectionalLight`, `EnvironmentLight`, `AmbientLight` | Lights |
| `IESProfile`, `parseIESProfile(text)` | Photometric profiles for `SpotLight` |
| `SceneBackground` | `[r, g, b, a]`, `Texture` or `GroundedSkyboxBackground` |

`Geometry`, `Texture` and `OpenPBRMaterial` expose `version` (initially `0`)
and `markUpdated(): this`. Versions advance with each call. Replacing geometry
or material references on a Mesh is detected automatically. Mesh projection
overrides apply to all its materials and require instance data to be rebuilt.
Both backends refit transform-only edits. Geometry version changes with stable
attribute/index arrays update only affected geometry and BLAS regions;
replaced arrays, displacement and simplification require full preparation.
Dynamic BLASes rebuild above twice their last build's total node surface area.

## Helpers

| Export | Description |
| --- | --- |
| `createPlaneGeometry`, `createCubeGeometry`, `createSphereGeometry`, `createCurvePlaneGeometry` | Procedural geometry (plane is 2×2 in XZ, cube and sphere span −1..1) |
| `generateVertexNormals`, `generateVertexTangents` | Attribute generation |
| `computeMeshesBoundingBox(meshes)` | World-space bounds |
| `loadRGBE(url)`, `parseRGBE(buffer)` | Radiance `.hdr` → float `Texture` |
| `fromTHREEScene`, `fromTHREECamera` | One-shot Three.js scene and camera conversion; see [Three.js](./threejs.md) |
| `THREESceneSync` | `new THREESceneSync(threeScene, options?)`; retains `scene` and resources across `update()` calls; CPU skinning/morph and shared-geometry instance expansion; `dispose()` releases caches |
| `THREESceneChanges` | Informational result of `update()`: `transforms`, `membership`, `content`, `lights`, `background`; no forwarding to Renderer needed |
| `FromTHREESceneOptions` | Optional `onMeshConverted(mesh, source, group, groupIndex)` callback; default: none |
| `loadGLTF(url)` | Minimal built-in glTF 2.0 loader; prefer Three.js `GLTFLoader` |
| `CameraViewControl` | Orbit/pan/zoom controller for a ClayPT `Camera` |
| `precomputeTinyBvh`, `prepareForPrecompute`, `precompute`, `resolveFromPrecompute` | BVH and displacement precomputation; see [BVH](./bvh.md) |
| `buildOpenSubdivAdaptiveFaceLevels` | Per-face levels for OpenSubdiv displacement |
| `VERSION` | Library version |

`claypt/oidn` exposes lower-level OIDN loading (`initializeOIDN`,
`initializeOIDNFromURL`, `DEFAULT_OIDN_WEIGHTS_BASE_URL`) for custom denoiser
setups.
