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
  `previewResolutionScale` and `previewBounces` control its cost. The preview
  resolution adapts to the measured frame time (aiming for `maxTimePreview`
  milliseconds) in 1/16 steps between 0.25 and `previewResolutionScale`.
  When denoising while converging, the measured denoise time also lowers it (down to
  0.125), and preview frames use the `previewModel` network (`small`).
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
- For large scenes, set `renderer.bvhBuilder = 'tinybvh'` and build BVHs up
  front with `await renderer.prepareScene(scene)`. Both builders automatically
  use a Worker for static BLAS construction (see
  [BVH](./bvh.md)).
- With Three.js, keep one `THREESceneSync` and call `sync.update()` before
  rendering `sync.scene` with `fromTHREECamera(threeCamera)` each frame.
  It preserves mesh, geometry, material, texture and light identities. One-shot
  conversion creates fresh resources and is intended for static setup.
- Animate existing mesh matrices while retaining the mesh objects and array.
  Both WebGPU and WebGL 2 refit changed TLAS instances and upload only
  affected instance/BVH ranges.
- For vertex animation, retain attribute/index arrays, set `geometry.dynamic =
  true` (default `false`), then call `geometry.markUpdated()` after edits.
  Changed geometries update their own vertex/BLAS regions and shared instance
  bounds. Displacement and simplification need full preparation; replaced
  arrays or changed lengths also require it.
- Three.js skinning and morph targets run on the CPU and retain deformation
  buffers. Cost scales with vertices, influences and material groups. An
  unchanged pose skips deformation. Dynamic BLASes rebuild when total node
  surface area exceeds twice the last build's total.
- InstancedMesh shares vertex data and BLAS but adds one TLAS instance per
  instance and group. Count edits rebuild instance/TLAS data. Instance colors
  add a cached material per distinct RGB value and source material; reuse
  colors to keep material packing and memory bounded.
- Call `material.markUpdated()` after parameter edits. Both backends repack
  parameters without geometry work. Emission edits also refresh sampling state,
  and texture edits rebuild the atlas. Non-emissive texture edits skip emissive
  triangle collection. Emissive bindings cache transformed triangles, and
  environment power is cached while its image is unchanged. Displacement geometry settings and
  tessellated displacement emission edits require full mesh updates.
- Analytic-light parameter edits retain the environment map. Ambient/environment
  edits resynthesize it. Rect-light texture edits still require a full mesh
  update because those textures belong to the material atlas.
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
