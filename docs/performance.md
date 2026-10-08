# Performance

## Resolution and samples

- Rays per sample scale with pixel count. Cap the device pixel ratio
  (`Math.min(devicePixelRatio, 2)` or lower on mobile).
- Set `maxSamples` for the quality you need. With a denoiser, 64–256 spp is
  usually enough; without one, 1000+ for clean results.
- Start with `bounces` 3–5. Raise it for glass, subsurface scattering or
  interiors lit indirectly, not everywhere.
- `clamping` removes fireflies at the cost of bias; use the smallest value
  that works.

## Responsiveness

- Keep `interactivePreview` on for camera controls and editing.
  `previewResolutionScale` and `previewBounces` control its cost.
- Large frames are split into tiles that target `maxTimePerTile`
  milliseconds of GPU time, which keeps the page responsive. Raise it for
  throughput in a background or export tab.
- `allowMultipleSamplesPerFrame = true` lets fast GPUs add several samples per
  `render()`.
- For exports, `renderOfflineFrame` with `targetBatchTimeMs` adapts batch sizes
  to the GPU; omit `previewIntervalMs` for maximum throughput.

## Scene setup

- Reuse `Geometry`, `OpenPBRMaterial` and `Texture` objects. Shared geometry
  shares its BVH and GPU buffers.
- Build BVHs up front with `await renderer.prepareScene(scene)`, or in a
  worker (see [BVH](./bvh.md)).
- With Three.js, pass a persistent `geometryCache` to `fromTHREEScene` and
  re-convert only when the scene changed.
- For animated transforms on WebGPU, use
  `renderer.markMeshTransformsDirty(meshes)` so only the top-level BVH is
  refit.
- Textures are packed into a texture atlas bounded by
  `textureAtlasBudgetBytes`; oversized textures are downscaled. Check
  `renderer.getDiagnostics()?.textureAtlas` when you hit limits.

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
