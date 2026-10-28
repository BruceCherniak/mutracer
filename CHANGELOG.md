# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.2.0 - 2026-10-28

Faster WebGPU rendering, surface AOVs and procedural skies.

### Performance

Compared with v0.1.5, WebGPU shader compilation time drops 53.8% and render time drops 25.6% on Apple M4 Max (geometric means over 10 glTF scenes):

| GPU | Shader compilation | Render time |
| --- | ---: | ---: |
| Apple M4 Max | -53.8% | -25.6% |

Results vary by scene, hardware, GPU load and shader cache.

<details>
<summary>Per-scene results</summary>

Chrome 156, WebGPU, 1280×720, full-frame rendering without tiling, 3 bounces, denoising off. Render time is 32 samples after warmup, excluding loading, preparation and shader compilation. Each run uses the median of three measurements; results are medians of three runs. Shader compilation times are from the previous measurements. Values are v0.1.5 → v0.2.0 in seconds.

| Scene | M4 Max compile | M4 Max render |
| --- | ---: | ---: |
| Classroom 2 | 2.32 → 1.15 | 3.49 → 2.52 |
| Bathroom | 2.34 → 1.01 | 3.20 → 2.49 |
| BMW M6 | 2.13 → 0.88 | 1.55 → 0.97 |
| House | 2.15 → 0.93 | 1.63 → 1.30 |
| Kitchen | 2.12 → 0.92 | 2.69 → 1.98 |
| Blender Cover Remix | 2.35 → 1.15 | 1.34 → 0.91 |
| LEGO Technic Bugatti Chiron | 2.13 → 1.01 | 1.46 → 1.15 |
| 2025 Yamaha MT-09 SP V4 | 2.34 → 1.16 | 1.97 → 1.62 |
| Gelatinous Cube | 2.31 → 1.15 | 2.60 → 2.02 |
| Dragon | 2.16 → 1.03 | 1.76 → 1.32 |

</details>

### Added

- Surface AOVs (`render.aovs`, `aovSamples`): depth, position, ID, motion and directional reflectance, on WebGPU and WebGL 2. View them with `display.channel`, read them back, or pass them to a custom denoiser.
- `render.refine(kind)` traces a single AOV without adding beauty samples.
- `batchSamples` lets one `refine()` call submit several samples within its time budget, so still renders are no longer limited to one sample per frame.
- `ProceduralSky`: clear-sky environment textures.
- `EquirectBackground` with `intensity` and rotation, synced from Three.js `backgroundIntensity` and `backgroundRotation`.
- Experimental WebGPU bindless material textures (`textureBinding: 'auto'`), falling back to the texture atlas.

### Changed

- SDR display and denoising use exact sRGB encoding on all backends instead of the browser's gamma 2.2 approximation. Dark and midtone pixels may look slightly different.
- Progressive denoising updates are at least 500 ms apart.

### Deprecated

- `allowMultipleSamplesPerFrame`; use `batchSamples`.

### Fixed

- Public TypeScript declarations resolve under NodeNext module resolution with `skipLibCheck` off.
- Shadow catcher contact shadows no longer weaken under environment light from below the receiver, or near emissive meshes on WebGPU.
- WebGL 2 waits for asynchronously compiled shaders before drawing.
- Diagnostic channels show their original images without color denoising; native albedo display now matches the browser.
- Native HDR presentation applies JNLM to extended-range output and can show completed display-linear denoising results.

## 0.1.5 - 2026-10-22

### Fixed

- Coat normals no longer inherit the base normal map. Assign the same texture to both maps to perturb both layers.

## 0.1.4 - 2026-10-21

### Added

- Environment and grounded skybox intensity and rotation, synchronized from Three.js scenes.
- Per-axis texture wrapping (repeat, clamp-to-edge, mirrored-repeat).
- Explicit sRGB or linear decoding for color textures, preserved from Three.js.

### Fixed

- Three.js conversion keeps vertex colors, back-side materials and half-float or R/RG/RGB/RGBA data textures.
- Converted equirectangular environments match Three.js orientation.
- Fully metallic glTF materials without a metalness map ignore specular settings, as in glTF.
- Spot light falloff between the inner and outer cones.

## 0.1.3 - 2026-10-19

### Changed

- `webgpu-utils` is no longer a dependency.

### Fixed

- Adding untextured lights after a scene update.
- WebGPU shadow catcher edges over opaque flat backgrounds, and OIDN artifacts around silhouettes over shadow catchers.

## 0.1.2 - 2026-10-16

### Added

- `displacementBias` (default `0`) for signed displacement offsets on WebGPU.

### Changed

- `displacementStepSize` defaults to `0` (1/32 of the displacement height). Set `0.01` for the previous behavior.
- Three.js materials without a displacement map convert with MuTracer's default height `0.1` instead of `1`.

### Fixed

- Displacement updates after map, image or height edits, including shared geometry, and stays consistent under scaled transforms.
- WebGL 2 renders the undisplaced surface when displacement settings are present.
- Stationary clicks with Three.js controls keep accumulated samples.

## 0.1.1 - 2026-10-14

### Changed

- Interactive previews adapt resolution to frame latency.

### Fixed

- Denoised previews stay responsive during interaction and transition smoothly to the final render.
- Three.js camera damping settles reliably.
- Animation and incremental geometry updates keep prepared BVHs.
- Shadow catcher denoising uses albedo and normal guides.

## 0.1.0 - 2026-10-14

### Added

- Progressive path tracing on WebGPU with a WebGL 2 fallback.
- Area, sphere, spot/IES, directional and environment lights with MIS.
- OpenPBR 1.1 materials.
- Worker-built static BVHs (TypeScript SAH or TinyBVH WebAssembly) with instance refits.
- OIDN denoising for previews and final images.
- Three.js scene conversion and synchronization with `THREESceneSync`.
- Sobol, ZSobol and random sampling, deterministic offline rendering and adaptive sampling.
- Tone mapping, color grading, bloom, shadow catchers, transparent backgrounds and depth of field.
