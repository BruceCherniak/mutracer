# MuTracer native viewer

A small standalone macOS arm64 example. It loads local GLTF/GLB models and
renders with the native MuTracer library. The app requires no browser,
JavaScript engine, Node installation or prepared GPU capture at runtime.

## Build and open

Install Rust, Xcode Command Line Tools, project npm dependencies and scriptc
**0.3.2**, then run from the repository root:

```sh
export MUTRACER_SCRIPTC=/absolute/path/to/node_modules/.bin/scriptc
npm run native:viewer
```

The app opens with the included procedural sample. Use **Open GLTF / GLB…** or
drop a model into the window. Keep external `.bin` files and images beside their
`.gltf` file. You can also open a model at launch:

```sh
npm run native:viewer -- /absolute/path/model.glb
```

`npm run native:viewer:build` builds without opening the app. The result is
`.native-build/viewer/MuTracer.app`; the app includes its sample and can be
opened without the project files or build tools on the tested macOS arm64 machine. `MUTRACER_NATIVE_OUTPUT` changes the output directory and
`CARGO_TARGET_DIR` selects a reusable Cargo cache. Other platforms are unverified.

## Controls

- Drag the image to orbit; right-drag or Shift-drag to pan; scroll to zoom.
  **Fit model** or **F** restores framing.
- Select a material and edit base color, roughness, metalness or transmission.
  Imported base-color, normal, metallic/roughness and emissive maps remain active.
- Adjust environment intensity, tint, rotation and background visibility.
  **Load HDR…** opens a local Radiance equirectangular environment; **Studio**
  restores the built-in light.
- Choose sample count and resolution, pause/resume, restart accumulation, adjust
  exposure or save the displayed image as PNG. The preview uses Reinhard/sRGB.

Camera changes restart accumulation while retaining the scene. Material,
environment and resolution edits rebuild the scene and restart accumulation;
these updates can pause interaction briefly. Material/environment sliders apply
when released. Exposure changes only the displayed image. The example reads
pixels back to CPU memory between progressive batches, which limits throughput.

## Supported inputs and limits

The example displays the default glTF scene, or the first scene if none is marked
default. Static triangle meshes, strips and fans, node transforms, shared mesh
instances, RGB vertex colors, two UV sets and core metallic/roughness PBR are
supported. Missing normals and tangents are generated. Scalar transmission/IOR,
unlit materials and emissive strength are also supported.

Material textures are limited to 512 pixels on their longest side. Textures use
repeat wrapping, native filtering and offset/scale UV transforms; texture rotation and normal-map
UV transforms are unsupported. Vertex-color alpha, occlusion and transmission
textures are ignored. Unsupported optional extensions are reported in the panel;
unsupported required extensions, skins and morph targets return an error.
Animations are not played. Draco, Meshopt and Basis/KTX2 assets need conversion
before loading. This is a static sample viewer, not full glTF feature coverage.

File size is limited to 128 MiB, combined geometry buffers to 64 MiB and source
material images to 16M pixels each, and environments to 4M pixels. The native
library imposes additional
scene/texture budgets described in [the native guide](../README.md#limits).
Rendering uses software BVH traversal through wgpu/Metal, with six bounces.
HWRT, denoising and device-loss recovery are not exposed by this viewer.
