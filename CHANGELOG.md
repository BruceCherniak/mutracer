# Changelog

All notable changes to MuTracer will be documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.1.5 - 2026-10-22

### Fixed

- Coat normals remain independent of base normal maps on WebGPU and WebGL 2. A material without a coat normal map keeps a smooth coat over a bumpy base; assign the same texture to both maps to perturb both layers.

## 0.1.4 - 2026-10-21

### Added

- Environment lighting supports intensity and rotation, including automatic synchronization from Three.js scenes.
- Grounded skybox backgrounds support independent intensity and rotation while keeping the ground level.
- Material textures support independent repeat, clamp-to-edge and mirrored-repeat wrapping on each axis, including Three.js conversion and viewer controls with undo/redo.
- Material color textures support explicit sRGB or linear decoding and preserve Three.js color-space settings.
- The viewer includes a glass shader ball sample.

### Fixed

- Three.js conversion preserves vertex colors, back-facing materials and material data textures with half-float, Red, RG, RGB or RGBA inputs.
- Converted equirectangular environments follow Three.js orientation and remain correct when the same texture is also used by a material.
- Fully metallic glTF materials without a metalness map ignore specular intensity, color and maps, matching glTF behavior.
- Spot lights use the correct smooth falloff within the inner and outer cones on WebGPU and WebGL 2.
- Rapid material edits in the viewer remain stable while GPU denoising is active.

## 0.1.3 - 2026-10-19

### Changed

- Installing the library no longer pulls in `webgpu-utils`.

### Fixed

- Adding untextured lights after a scene update works correctly on WebGPU and WebGL 2.
- WebGPU shadow catchers blend seamlessly into opaque flat backgrounds at receiver edges, including with bloom and HDR output.
- WebGPU OIDN denoising reduces colored artifacts around foreground silhouettes over shadow catchers with textured or translucent backgrounds.

## 0.1.2 - 2026-10-16

### Added

- WebGPU displacement supports `displacementBias` (default `0`) for signed height offsets in mesh-local units, including conversion from Three.js materials.

### Changed

- `displacementStepSize` now defaults to `0`, automatically using 1/32 of the absolute displacement height. Set `0.01` explicitly to retain the previous fixed step; smaller steps capture finer detail at a higher rendering cost.
- Converting a Three.js material without a displacement map now uses MuTracer's default height of `0.1` instead of Three.js's inactive default of `1`. Other configured heights are preserved.

### Fixed

- Editing displacement maps, image sources or height settings updates the rendered surface correctly, including meshes that share geometry.
- Displacement remains consistent when object transforms scale the mesh, including small displacement heights.
- WebGL 2 renders the original surface correctly when displacement settings are present; displacement requires WebGPU.
- Clicking or holding a stationary view with Three.js controls preserves accumulated samples and completed renders.

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
