# API reference

Exports come from `@meimu/mutracer`; declarations carry TSDoc and defaults.
See [progressive rendering](./progressive-rendering.md) for complete examples.

## Engine

`new Engine({canvas?, backend?, device?})` manages the device and one GPU
scene. `scene` and `camera` default to undefined. Assign them and call
`update()` to commit edits before rendering; see [updates](./updates.md).

| Setting | Default | Meaning |
| --- | --- | --- |
| `canvas` | new HTML canvas, or OffscreenCanvas without document | Accepts either canvas type; default `engine.display.canvas` |
| `device` | undefined | Caller-owned WebGPU device; see [requirements](#device-requirements) |
| `backend` | `'auto'` | Automatic WebGPU/WebGL selection; `'webgpu'` requires WebGPU; `'webgl'` forces WebGL 2 |
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
| `setDevice(device)` | Replace a caller-owned device; see [device loss](#device-loss) |
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

### Device requirements

`EngineParams.device` defaults to undefined (the library's shared device). A
supplied device implies WebGPU, even with `backend: 'auto'`, and cannot be
combined with `backend: 'webgl'`. `init()` rejects unsupported limits through
`lastError` and the `error` event, listing each required and actual value. The
device is caller-owned; `dispose()` does not destroy it or share it with other
engines implicitly. Adapter name uses `device.adapterInfo` when available,
otherwise `WebGPU`.

`getRecommendedDeviceDescriptor(adapter)` requests supported optional features
and the adapter limits used by the default engine path. Core rendering needs
no optional features: timestamp-query falls back to wall-clock timing; core
shaders use f32 and manual float texture filtering. shader-f16 and subgroups
are OIDN optimizations; its automatic precision falls back to FP32 and its
non-subgroup kernels remain available. Texture-format tier features and
bgra8unorm-storage are not prerequisites for the core render-attachment path.
Explicit OIDN FP16 or WebNN options can require shader-f16.

The core floor is 8 storage buffers, 8 sampled textures, 1 storage texture,
4 bind groups, workgroup X 64 / Y 16 / 256 invocations, and 12288 bytes for
buffer size and storage-buffer binding size (one aligned 16×16 target block).
Core kernels need 0 bytes of workgroup shared memory. Actual scene, image and
texture sizes impose larger buffer and texture limits. OIDN shares this same
device and can require more buffer capacity and workgroup shared memory for
its convolution tiles; the recommended descriptor requests adapter maxima.
Use smaller OIDN tiles or automatic precision when appropriate; network
initialization reports incompatible configurations.

### Device loss

`engine.on('devicelost', ({reason, recovering}) => ...)` reports loss, including
an externally destroyed shared device. Shared devices recover on the next
`update()` or `refine()`; renders report `preparing`, discard their samples,
and upload the committed scene again. CPU BVHs, decoded textures and downloaded
OIDN weights remain cached. Device-bound networks reload. Multiple engines
share the new device. Active `converge()` rejects with a device-loss error.
RenderLoop keeps ticking during recovery.

For caller-owned devices, `recovering` is false, renders report `error`, and
`lastError` explains the loss. Call `await engine.setDevice(replacement)` and
then `engine.update()` to resume. It uses the same limit validation as init;
only engines originally constructed with `device` accept setDevice. The
replacement is also caller-owned. Custom denoisers detect changes in
`input.device` / `prepare({device})` and rebuild their own resources.

WebGL context loss also reports `devicelost` with reason `webglcontextlost` and
`recovering: true`. Rendering waits in `preparing` until the browser dispatches
`webglcontextrestored`, then rebuilds resources and restarts all renders.

## Render

`new Render(engine, options?)` creates one independent accumulation. All renders
use the engine's committed scene/camera. Options are mutable except fixed
constructor dimensions. Image-quality changes restart only this render;
budget and display changes retain samples. Batch assignments use
`Object.assign(render, settings)` with `RenderSettings`, or constructor options.
`maxSamples` changes restart accumulation only with `samplingPattern: 'zsobol'`;
other sequences retain their completed samples.

| Option | Default | Meaning |
| --- | --- | --- |
| `maxSamples` | `2048` | Complete sample budget |
| `bounces` / `clamping` | `3` / `0` | Scattering depth / per-sample radiance clamp; 0 disables clamping |
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
| `denoiser` | `null` | Per-render configuration; read back through the frozen `denoiser` getter and change with `setDenoiser()`; see [denoising](./denoising.md) |

`bounces` is rounded and clamped to [1, 20] in both backends; NaN becomes 1.
The path loop allows at most `min(bounces * 3, 20)` events, including transmission,
alpha skips and escape checks. Opaque paths also have their own scattering-depth
termination. This event budget can truncate deep transparent paths even when
the requested scattering depth is larger. Intel Mac WebGL retains its driver
workaround: `min(bounces, 3)` loop events, doubled for scenes with transmission
or alpha, plus its existing early depth termination.

| Method / property | Meaning |
| --- | --- |
| `refine()` | Trace within this render's budget; returns status |
| `converge(options)` | Deterministic offline image; see below |
| `readPixels(kind = 'hdr')` | Read this render; see [pixel outputs](#pixel-outputs) |
| `engine` | Owning engine |
| `denoising` | Queued/running inference, including intermediate updates; default false |
| `on('sample', listener)` | Complete samples: `{samples, isFirstFrame, frameTimeMs}`; returns unsubscribe |
| `samples` | Complete samples since restart; stale engine inputs report 0 |
| `converged` | `samples >= maxSamples`, independently of filtering |
| `status` | Preparing, compiling, converging, denoising, finished or error |
| `setDenoiser(options)` | Replace the denoiser configuration; resolves when the filter is ready |
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

## RenderLoop and Sync

`start()` uses requestAnimationFrame when available and a 16 ms setTimeout
otherwise. Worker visibility and control forwarding are described in
[worker integration](./getting-started.md#running-in-a-worker).

`new RenderLoop(engine, options?)` provides the interactive policy described in
[progressive rendering](./progressive-rendering.md#loop-policy).

| Option | Default | Meaning |
| --- | --- | --- |
| `display` | engine.display | Display used for presentation |
| `preview` | half-resolution adaptive Render | Render, RenderOptions or false; default quality in [ownership](./progressive-rendering.md#options-and-ownership) |
| `final` | new Render with preview fallback | Render or RenderOptions |
| `sync` | none | Sync or ordered Sync array on this engine |
| `idleMs` | 150 | Consecutive-edit idle deadline in milliseconds |
| `coalesceSceneUpdates` | false | Defer commits during preview inference, then commit latest camera/scene |

`engine`, `display`, `preview` (possibly undefined) and `final` are read-only.
`changing` defaults false; `samples` counts final only and reports 0 during preview; `status` starts preparing.
`select({changing})` defaults to changing ? preview : final. `addSync`/`removeSync`
manage integrations without disposing them. `tick` executes a manual frame;
`start`/`stop` manage animation frames. `converge` accepts the same options as
Render.converge and resumes a started loop. `dispose` releases owned renders.

Events: `status` carries `{status, previous}` only on transitions; `sample`
carries `{samples, preview: false, isFirstFrame, frameTimeMs}` for final only.
`on` returns unsubscribe and supports multiple listeners.

Extend `Sync` with `constructor(engine)` and `update(): void`. `engine` is readonly;
`active` defaults false. Integrations can use protected `setActive(boolean)` or
`activateFor(ms)`; `dispose()` clears base activity. Construction must not write
to the engine. Three.js integration uses [THREESync](./threejs.md#options).

## Display

`Display.canvas` is `HTMLCanvasElement | OffscreenCanvas`. `toBlob()` uses
OffscreenCanvas.convertToBlob in a worker or for an offscreen display. See
[worker integration](./getting-started.md#running-in-a-worker).

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
Use the exported `DisplaySettings` type for a partial batch:

```ts
const settings: DisplaySettings = {toneMappingExposure: 2, bloomIntensity: 0.2};
Object.assign(engine.display, settings);
engine.display.present(render);
```

Ordinary setting fields remain enumerable and read back the assigned value.
For example, `bevelSamples` and `directLightCandidates` are clamped when
submitted, without rewriting the assigned field. Existing accessors for
resolution, fallback and worker count retain their validation rules.

`DenoiserOptions` is a union of `JNLMDenoiserOptions`, `OIDNDenoiserOptions`
and `CustomDenoiserOptions`,
with required `type`. The getter is frozen; reassign to edit. Invalid types,
foreign fields and invalid JNLM settings preserve the previous filter and
result. Schedule-only edits keep inference running. See [denoising](./denoising.md).

`Denoiser` is the caller-owned third-party WebGPU interface. Its optional
`prepare` receives device/dimensions, and `denoise` receives `DenoiseInput`
plus abort signal/schedule.
The packed buffer formats, ownership, cancellation, device changes and display
semantics are documented in [Custom denoisers](./denoising.md#custom-denoisers).

### Pixel outputs

`readPixels(kind = 'hdr')` returns `{ width, height, data: Float32Array }`,
RGBA with the top row first. Dimensions describe the internal render texture,
which WebGPU rounds up to multiples of 16. Before a pipeline exists, it returns an empty image.

| Kind | Values |
| --- | --- |
| `hdr` | Original linear HDR samples, unchanged by denoising |
| `denoised` | Completed output: custom WebGPU filters return native resolved HDR ray color before display background/catcher composition; built-in WebGPU filters normally return display-linear after composition/tone mapping; WebGL JNLM returns tone mapped, display encoded colors |
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
| `Scene` | `{ meshes: (Mesh \| InstancedMesh)[], lights, background? }`; see below |
| `Mesh` | `new Mesh(geometry, material \| material[])`, `transform` |
| `InstancedMesh`, `InstancedMeshOptions` | `new InstancedMesh(geometry, material \| material[], {count, transforms?, colors?})`; local Float32 column-major matrices default to identity, multiplied by inherited transform; count selects the active prefix; `colors` defaults to undefined (white linear RGB); `markUpdated(): this` notifies both matrices and colors; `markTransformsUpdated(start = 0, count = this.count - start): this` and `markColorsUpdated(start = 0, count = this.count - start): this` notify each separately. Each advances version once, initially 0. See [updates and costs](./updates.md#instanced-meshes) |
| `Geometry`, `GeometryAttribute` | Triangle data: required `position`; optional `normal` and `indices` are generated at construction; `vertexCount` / `triangleCount` getters; optional `uv`, `uv1`, `tangent`, `color`, `materialIndex` (raw per-vertex indices, itemSize 1; all three corners of each triangle must match; invalid indices fall back to material 0 with one warning); `dynamic` (default `false`) for [deforming geometry](./updates.md#dynamic-geometry) |
| `OpenPBRMaterial` | `new OpenPBRMaterial(params?)`; see [materials](./materials.md) |
| `Texture` | HTMLImageElement, HTMLCanvasElement, ImageBitmap, OffscreenCanvas or `{ data, width, height }`; `Uint8Array`/`Uint8ClampedArray` color is sRGB; `Float32Array`/`Int32Array` color is linear; independent `wrapS` / `wrapT`: `'repeat'` (default), `'clamp-to-edge'`, `'mirrored-repeat'`, applied after UV scale/offset for material textures |
| `Camera` | `new Camera({ projection: 'perspective', ... })` or orthographic; `position`, `lookAt()`, `copy(source)`, `clone()`; aspect defaults to automatic; depth of field with `fStop`, `focusDistance`, `sensorHeight`, `metersPerUnit` ([details](./getting-started.md#depth-of-field)) |
| `RectLight`, `SphereLight`, `SpotLight`, `DirectionalLight`, `EnvironmentLight`, `AmbientLight` | Parameter-object constructors; analytic lights use `transform`, `position`, `lookAt()` and rigid axes. See [lights](./getting-started.md#lights) |
| `IESProfile`, `parseIESProfile(text)` | Photometric profiles for `SpotLight` |
| `SceneBackground` | `[r, g, b, a]`, `Texture` or `GroundedSkyboxBackground` |

`OpenPBRMaterial` accepts canonical `specularRoughnessAnisotropy` (default `0`),
`coatRoughnessAnisotropy` (`0`), `subsurfaceScatterAnisotropy` (`0`),
`geometryOpacity` (`1`) and `geometryThinWalled` (`false`). The old names are
deprecated aliases sharing storage; conflicting constructor values throw.
See [compatibility names](./materials.md#compatibility-names).

`OpenPBRMaterial` also accepts `thinFilmThicknessMinimum` (default `0` µm)
and `thinFilmMapChannel` (default `r`, one of `r/g/b/a`). `thinFilmThickness`
(default `0.5` µm) is the maximum endpoint with a map and the constant without
one. See [thin-film textures](./materials.md#textures) for range behavior.

`coatWeightMap`, `coatRoughnessMap`, `fuzzColorMap`, `fuzzRoughnessMap`,
`specularWeightMap` and `specularColorMap` accept `Texture` and each default to
`undefined`. Channels and color decoding are listed in [material textures](./materials.md#textures).
They follow the existing material/texture update mechanism.

`coatNormalMap` defaults to `undefined`, retaining the shared shading normal. With a map, linear RGB supplies an independent coat normal; `coatNormalScale` defaults to `[1, 1]` and scales its decoded XY. See [coat normals](./materials.md#coat-normals) for frame, sampling and update behavior.

Raw texture sources contain exactly `width * height * 4` RGBA values, with
rows ordered from top to bottom. `Uint8Array` and `Uint8ClampedArray` store
8-bit values: color slots decode RGB from sRGB, while data slots (roughness,
normal, coat weight, etc.) read normalized channels directly. `Float32Array`
(and `Int32Array` with linear integer values) supplies linear color and data
channels, including HDR colors above 1. These sources can share a material
texture array with Canvas images and other image sources on both backends.

Material arrays containing linear raw sources use half-float storage (finite
range up to 65504, rounded to half-float precision) and twice the bytes per
pixel of an 8-bit array. Raw sources retain straight alpha and their original
RGB even at zero alpha; Canvas composition can discard transparent RGB and
round partially transparent colors. When the atlas budget requires resizing,
raw sources use nearest-neighbor downsampling; image sources use Canvas
resampling. Equal dimensions and opaque pixels allow exact byte/image
comparisons. Float colors interpolate in linear space, while 8-bit color
samples interpolate before sRGB decoding; gradients can therefore differ even
when their endpoint colors agree. Half-float and 8-bit filtering also have
different precision.

`Geometry` and `Texture` expose `version` (initially `0`)
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
| `THREESync` | Keeps a `THREE.Scene` in sync: `new THREESync(engine, {scene?, camera?, controls?, updateControls?})`; RenderLoop calls update; dispose when done; conversion hooks `convertMaterial` / `convertLight`; see [Three.js](./threejs.md#custom-conversion) |
| `fromTHREECamera(camera, options?)` | Converts a Three.js camera; one-shot conversion; THREESync retains and updates cameras. Reads `focus` and the film height; `FromTHREECameraOptions` sets `fStop` (default `0`), `focusDistance` and `metersPerUnit` (default `1`) |
| `fromTHREEScene` | One-shot Three.js scene conversion with FromTHREESceneOptions conversion hooks; every call reruns hooks and creates fresh default objects |
| `FromTHREESceneOptions` | Optional `onMeshConverted(mesh, source, group, groupIndex)` callback; default: none |
| `VERSION` | Library version |

`@meimu/mutracer/oidn` exports weight constants (`OIDN_MODEL_FILENAMES`,
`OIDN_AUXILIARY_MODEL_FILENAMES`, `OIDN_WEIGHTS_PACKAGE`,
`OIDN_WEIGHTS_PACKAGE_VERSION`, `DEFAULT_OIDN_WEIGHTS_BASE_URL`,
`DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL`) and `resolveOIDNModelUrl` /
`resolveOIDNAuxiliaryModelUrls`. Configure packaged/custom OIDN networks,
execution engines, precision and dynamic tiles through `render.setDenoiser()`;
see [denoising](./denoising.md#custom-oidn-networks). The main entry exports
`OIDNEngine`, `OIDNPrecision`, `OIDNHDRTransfer`, `OIDNDynamicTileOptions`,
`OIDNDynamicTileSetting` and `OIDNAuxiliaryModelUrls` as types.

## GPU output and display passes

`render.getOutputTexture(kind)` borrows native HDR or the latest display image;
`display.addPostProcess(pass)` returns unregister and runs on every present/export.
Both are WebGPU-only. See [formats, lifecycle and overlay example](./post-processing.md).

Anisotropy direction options: `anisotropyMap` (default `undefined`) reads linear RG as a tangent direction and B as a multiplier for base specular strength. `specularAnisotropyRotation` (default `0`) rotates that direction counter-clockwise in radians; `coatAnisotropyRotation` (default `0`) rotates the coat relative to the geometry tangent. See [materials](./materials.md#anisotropy-directions) for frame and fallback conventions.

`specularAnisotropyModel` defaults to `'openpbr'`. Selecting `'gltf'` keeps `specularRoughness` as source perceptual roughness and `specularRoughnessAnisotropy` (or its compatibility name) as source strength. The renderer converts both after their texture factors and before coat roughening. See [source conversion](./threejs.md#anisotropy-source-conversion) for the equations and metadata precedence.
