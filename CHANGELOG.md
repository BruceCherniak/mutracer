# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.0 - Unreleased

### Added

- Progressive browser path tracing on WebGPU with a WebGL 2 fallback.
- Area, sphere, spot/IES, directional and environment lights with multiple importance sampling.
- OpenPBR 1.1 materials including coat, fuzz, thin film, transmission, subsurface and emission.
- TinyBVH binned SAH acceleration in TypeScript, optional asynchronous wasm building and instance-transform refits.
- OIDN denoising for final images and converging previews; bundled standard/small networks and an independent complete weights package.
- Three.js scene conversion and retained synchronization with THREESceneSync.
- Sobol, ZSobol and random sampling, deterministic offline rendering and adaptive sampling.
- Tone mapping, color grading, bloom, shadow catchers, transparent backgrounds and depth of field.
- API documentation, procedural examples and a viewer for exploring scenes and exporting images.
