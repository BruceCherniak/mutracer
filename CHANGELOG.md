# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Surface AOVs (`render.aovs`, `aovSamples`): depth, position, ID, motion and directional reflectance outputs on WebGPU and WebGL 2, shown through `display.channel`, read back per kind and passed to custom denoisers.
- `render.refine(kind)` traces one AOV without adding beauty samples.
- `batchSamples` lets one `refine()` submit several samples within the time budget, so still renders no longer cap at one sample per frame.
- `ProceduralSky` clear-sky environment textures.
- `EquirectBackground` with `intensity` and rotation, synchronized from Three.js `backgroundIntensity` and `backgroundRotation`.
- Experimental WebGPU bindless material textures with `textureBinding: 'auto'`, falling back to the atlas.

### Changed

- SDR display and denoising use sRGB encoding on all backends, replacing the browser's gamma 2.2 approximation. Dark and midtone pixels can change.
- Intermediate progressive denoising updates are at least 500 ms apart.
- Faster WebGPU shader compilation and rendering. Compared with v0.1.5, a 10-scene glTF benchmark on Apple M4 Max (640×360, 3 bounces) measured 54% lower cold shader preparation/compilation time and 21% lower GPU path-tracing time (geometric means across scenes). Results vary by hardware and scene.

Apple M4 Max benchmark values below are v0.1.5 → Unreleased, using Chrome 156 and medians of three independent runs. GPU times are per sample, measured using 32-sample renders after warmup with denoising disabled.

| Scene | Cold shader preparation/compilation (s) | Change | GPU path tracing (ms/sample) | Change |
| --- | ---: | ---: | ---: | ---: |
| Classroom 2 | 2.32 → 1.15 | -50.6% | 19.61 → 15.05 | -23.2% |
| Bathroom | 2.34 → 1.01 | -57.0% | 18.64 → 14.86 | -20.3% |
| BMW M6 | 2.13 → 0.88 | -58.9% | 10.66 → 8.30 | -22.2% |
| House | 2.15 → 0.93 | -56.9% | 12.66 → 9.89 | -21.8% |
| Kitchen | 2.12 → 0.92 | -56.6% | 15.15 → 12.10 | -20.1% |
| Blender Cover Remix | 2.35 → 1.15 | -51.0% | 9.28 → 7.53 | -18.8% |
| LEGO Technic Bugatti Chiron | 2.13 → 1.01 | -52.5% | 16.10 → 13.11 | -18.6% |
| 2025 Yamaha MT-09 SP V4 | 2.34 → 1.16 | -50.4% | 16.28 → 12.95 | -20.5% |
| Gelatinous Cube | 2.31 → 1.15 | -50.3% | 17.52 → 14.11 | -19.5% |
| Dragon | 2.16 → 1.02 | -52.5% | 14.17 → 11.34 | -19.9% |

On Windows 11 with an NVIDIA GeForce RTX 4060 Laptop GPU (driver 617.42), the same 10 scenes at 640×360 and 3 bounces measured 74.4% lower shader preparation/compilation time and 58.8% lower GPU-completed 32-sample render time (geometric means across scenes). Time from BVH preparation completion to the first complete sample fell 71.5%. Results vary by hardware and scene.

Windows values below compare `a646620` → `08d6c63`, using headless Chrome 156 and three independent processes per version and scene. Each process measured three 32-sample renders after an 8-sample warmup, with Sobol sampling, atlas textures and denoising disabled; values are medians within and across processes. Rendering waits for GPU completion and excludes pixel readback, but includes scheduling and post-processing, so these times are not directly comparable to the GPU-only M4 Max timings above. The canvas is 640×360; both versions align their internal render targets to 640×368.

| Scene | Shader preparation/compilation (s) | Change | GPU-completed render (s/32 samples) | Change |
| --- | ---: | ---: | ---: | ---: |
| Classroom 2 | 7.900 → 2.176 | -72.5% | 21.518 → 1.360 | -93.7% |
| Bathroom | 8.134 → 1.913 | -76.5% | 1.395 → 1.028 | -26.3% |
| BMW M6 | 7.349 → 1.535 | -79.1% | 0.771 → 0.485 | -37.1% |
| House | 7.388 → 1.670 | -77.4% | 1.243 → 0.636 | -48.9% |
| Kitchen | 7.295 → 1.726 | -76.3% | 10.093 → 0.859 | -91.5% |
| Blender Cover Remix | 8.379 → 2.509 | -70.1% | 0.573 → 0.450 | -21.5% |
| LEGO Technic Bugatti Chiron | 7.156 → 1.818 | -74.6% | 1.208 → 0.679 | -43.8% |
| 2025 Yamaha MT-09 SP V4 | 8.170 → 2.431 | -70.2% | 1.266 → 0.885 | -30.1% |
| Gelatinous Cube | 8.273 → 2.485 | -70.0% | 1.369 → 0.957 | -30.1% |
| Dragon | 7.667 → 1.857 | -75.8% | 1.141 → 0.582 | -48.9% |

Windows compilation used fresh browser profiles, disabled shader disk caching and unique shader function names, but these controls do not guarantee an empty driver cache. Some scenes compiled more slowly in the first round despite these controls. Across individual rounds, geometric-mean compilation reductions ranged from 74.4% to 74.7%, and render-time reductions from 57.0% to 59.4%.

### Deprecated

- `allowMultipleSamplesPerFrame`; use `batchSamples`.

### Fixed

- Shadow catcher contact shadows no longer weaken under environment light from below the receiver, or near emissive meshes on WebGPU.
- WebGL 2 waits for asynchronously compiled programs before drawing.
- Diagnostic channels show their original images without color denoising; native albedo display now matches browser values.
- Native HDR presentation applies JNLM to extended-range composition and can show completed display-linear denoising results.

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
