# MuTracer native viewer

A small standalone macOS arm64 example. It loads local GLTF/GLB models and
renders with the native MuTracer library. The app requires no browser,
JavaScript engine, Node installation or prepared GPU capture at runtime.

## Build and open

Install Rust, CMake, Xcode Command Line Tools, project npm dependencies and
scriptc **0.3.2**, then run from the repository root. The first build downloads
the native OIDN SDK (about 49 MiB), its source and regular model weights
(about 29 MiB more). The app includes regular/small models and omits the three
large weight sets. Native denoising adds about 28 MiB to the app and needs no
download when opened:

```sh
export MUTRACER_SCRIPTC=/absolute/path/to/node_modules/.bin/scriptc
npm run native:viewer
```

The app opens with the included procedural sample. Use **Open GLTF / GLB…** or
drop a `.gltf` or `.glb` file anywhere in the window. A drop target appears
while dragging. Loading keeps the previous image visible; failures show an error
without replacing the model. Keep external `.bin` files and images beside their
`.gltf` file. You can also open a model at launch:

```sh
npm run native:viewer -- /absolute/path/model.glb
```

`npm run native:viewer:build` builds without opening the app. The result is
`.native-build/viewer/MuTracer.app`; the app includes its sample and can be
opened without the project files or build tools on the tested macOS arm64
machine. `MUTRACER_NATIVE_OUTPUT` changes the output directory. Other platforms
are unverified.

## Controls

- Drag the image to orbit; right-drag or Shift-drag to pan; scroll to zoom.
  **Fit model** or **F** restores framing.
- Click a surface to select its object and open the **Material** panel. **Frame selection**
  fits the camera to that object. The **Scene** panel also lists selectable objects.
- Select a material and edit base color, roughness, metalness or transmission.
  Edits affect every object sharing that material. Picking tests geometry, so
  transparent surfaces can be selected ahead of objects behind them.
  Imported base-color, normal, metallic/roughness and emissive maps remain active.
- Adjust environment intensity, tint, rotation and background visibility.
  **Load HDR…** opens a local Radiance equirectangular environment; **Studio**
  restores the built-in light.
- Choose sample count and resolution, pause/resume, restart accumulation, adjust
  exposure or save the displayed image as PNG. The preview uses Reinhard/sRGB.
- **Native OIDN** is on by default. It denoises completed previews after interaction
  pauses, using Metal where available and CPU otherwise. Toggle it to compare
  the unfiltered image; PNG export uses the currently displayed result.
- **Ray tracing** defaults to **Auto**: use hardware queries for supported opaque
  scenes and software BVH otherwise. The panel reports the active path and any
  fallback reason. **Software** disables hardware queries; **HWRT** reports an
  error if the scene or device is unsupported.

Camera changes restart accumulation while retaining the scene. The previous
image remains visible until a newer preview arrives, including while dragging.
Basic color, roughness, metalness and transmission edits retain the scene's
geometry and textures and restart accumulation. Environment intensity, tint and
rotation also retain the scene when map dimensions and background mode stay the
same. Loading a different-sized HDR, switching background mode, changing shader
features or unlit materials, and changing resolution rebuild the scene. Moving
between zero and nonzero environment intensity can also require a rebuild. These
updates can pause interaction briefly. Full rebuilds are combined at
roughly 120 ms intervals while held, then applied when released.
Exposure and denoising change only the displayed image, preserving the original
HDR accumulation. Denoising does not block window interaction; a result for an
older scene, camera or sample count cannot replace the current preview.
The first denoise can take longer than later runs. Choose a lower render
resolution for more responsive interaction; a fixed frame rate is not guaranteed.

## Supported inputs and limits

The example displays the default glTF scene, or the first scene if none is marked
default. Static triangle meshes, strips and fans, node transforms, shared mesh
instances, RGB vertex colors, two UV sets and core metallic/roughness PBR are
supported. Missing normals and tangents are generated. Meshopt compression,
quantized geometry, WebP textures, mesh instancing, the initial static pose of skinned meshes (up to four joint influences) and default
morph weights are supported. Scalar transmission/IOR, unlit materials and emissive
strength are also supported.

Material textures are limited to 512 pixels on their longest side; models with
many images use a lower limit to fit the texture budget. Textures use
repeat wrapping, filtering and offset/scale UV transforms; texture rotation and
normal-map UV transforms are unsupported. Vertex-color alpha, occlusion and transmission
textures are ignored. Unsupported optional extensions are reported in the panel;
unsupported required extensions return an error.
Animations are not played. Sparse quantized attributes are unsupported.
Draco and Basis/KTX2 assets need conversion before loading. This is a
static sample viewer, not full glTF feature coverage.

File size is limited to 128 MiB, combined model buffers to 512 MiB and source
material images to 64M pixels each, and environments to 4M pixels. The native
library imposes additional scene/texture budgets described in
[the native guide](../README.md#limits).
Rendering uses wgpu/Metal with six bounces. HWRT support and fallbacks follow
[the native intersection limits](../README.md#intersection-backend).
Device-loss recovery is not implemented.
Native OIDN output can differ from browser OIDN output. Custom OIDN model
weights are not supported by this example.
