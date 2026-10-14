# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.1 - 2026-10-14

### Changed

- Interactive previews adapt resolution to tracing, denoising and display latency.

### Fixed

- Denoised previews remain responsive and finish during continuous interaction, with stable transitions to the final render.
- Three.js camera controls settle reliably and account for elapsed time when damping.
- Animation and incremental geometry updates retain prepared BVHs.
- Shadow catcher denoising receives auxiliary albedo and normal guides on both WebGPU and WebGL 2, reducing color artifacts.

## 0.1.0 - 2026-10-14

### Added

- Progressive browser path tracing on WebGPU with a WebGL 2 fallback.
- Area, sphere, spot/IES, directional and environment lights with multiple importance sampling.
- OpenPBR 1.1 materials including coat, fuzz, thin film, transmission, subsurface and emission.
- Static BLAS construction in a Worker with the TypeScript binned SAH builder or optional TinyBVH WebAssembly, selectable `bvhLayout`, and instance-transform refits.
- OIDN denoising for final images and converging previews; bundled standard/small networks and an independent complete weights package.
- Three.js scene conversion and retained synchronization with THREESceneSync.
- Sobol, ZSobol and random sampling, deterministic offline rendering and adaptive sampling.
- Tone mapping, color grading, bloom, shadow catchers, transparent backgrounds and depth of field.
- API documentation, procedural examples and a viewer for exploring scenes and exporting images.
