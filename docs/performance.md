# Performance

A tuning checklist. Each item links to the page with the details.

## Resolution and samples

- Rays per sample scale with pixel count. Cap the device pixel ratio
  (`Math.min(devicePixelRatio, 2)`, or lower on mobile).
- Set `maxSamples` for the quality you need. With a denoiser, 64–256 spp is
  usually enough; without one, 1000+ for clean results.
- Start with `bounces` 3–5. Raise it for glass, subsurface scattering or
  interiors lit indirectly, not everywhere.
- `clamping` removes fireflies at the cost of bias; use the smallest value
  that works.

## Responsiveness

- Keep `interactivePreview` on for camera controls and editing. The preview
  resolution adapts to the measured frame time (target `maxTimePreview` ms)
  between 0.25 and `previewResolutionScale`; `previewBounces` sets its depth.
  When [denoising while converging](./denoising.md#denoising-while-converging),
  denoise time also lowers it, down to 0.125.
- Large frames are split into tiles that target `maxTimePerTile` ms of GPU
  time, which keeps the page responsive. Raise it for throughput in a
  background or export tab.
- `allowMultipleSamplesPerFrame = true` lets fast GPUs add several samples per
  `render()`.
- For exports, `renderOfflineFrame` with `targetBatchTimeMs` adapts batch sizes
  to the GPU; omit `previewIntervalMs` for maximum throughput.

## Scene setup

- Share `Geometry`, `OpenPBRMaterial` and `Texture` objects. Shared geometry
  shares its BLAS and GPU buffers.
- For large scenes, try `renderer.bvhBuilder = 'tinybvh'` and build BVHs up
  front with `await renderer.prepareScene(scene)`; see [BVH](./bvh.md).
- With Three.js, keep one `THREESceneSync` for the whole session rather than
  converting again with `fromTHREEScene`.
- Textures share an atlas bounded by `textureAtlasBudgetBytes`; larger textures
  are downscaled. Check `renderer.getDiagnostics()?.textureAtlas`.

## Animation and editing

See [scene updates](./updates.md) for the cost of each kind of edit.

- Edit `mesh.matrixWorld` in place: transform changes only refit instances.
- For vertex animation, keep the arrays, set `geometry.dynamic = true` and call
  `geometry.markVerticesUpdated()`, not `markUpdated()`.
- Avoid [full mesh updates](./updates.md#full-mesh-updates) per frame:
  replacing arrays, changing displacement, or adding new geometry.
- Three.js skinning and morph targets run on the CPU; cost grows with
  vertices, bone influences and material groups. An unchanged pose is free.
- Each `InstancedMesh` instance adds one top-level BVH instance per material
  group. Each distinct instance color adds a cached material; reuse colors.

## Lighting

- Prefer `RectLight` and `SphereLight` to small emissive meshes: analytic
  lights are sampled directly and converge faster.
- Scenes with many lights benefit from more `directLightCandidates` (WebGPU).
- A bright, small sun in an environment map is importance sampled, but a
  `DirectionalLight` is cleaner when the sun is the key light.

## Shader compilation

The path-tracing shaders are large. The first frame can take several seconds
to compile on some platforms (`RENDER_STATUS_COMPILING_SHADER`). Materials
with displacement or alpha, and some renderer options, select shader variants
that compile on first use. Show a status while compiling, as the examples do.

## Diagnostics

`renderer.getDiagnostics()` reports the backend and adapter, shader
compilation times, BVH statistics, light sampling setup and GPU trace timing.
