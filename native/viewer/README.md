# MuTracer native viewer

A small standalone viewer for macOS arm64 and Linux x64. It loads local GLTF/GLB models and
renders with the native MuTracer library. The app requires no browser,
JavaScript engine, Node installation or prepared GPU capture at runtime.

## Download and open

Download the matching archive from [GitHub Releases](https://github.com/pissang/mutracer/releases):
`MuTracer-macos-arm64.zip` or `MuTracer-linux-x64.tar.gz`.
Extract the whole archive, then open `MuTracer.app` on macOS or `mutracer-viewer`
on Linux. Keep the executable, sample, OIDN libraries
and licenses together. SHA-256 checksum files accompany the downloads.

The macOS app is ad-hoc signed and not Apple-notarized.
Linux packages target Ubuntu 24.04 x64 and require a Vulkan driver and an X11 or
Wayland desktop. X11 sessions also need `libxkbcommon-x11-0`. Physical GPU behavior
outside the tested macOS hardware remains unverified.

Windows support remains experimental. Download `MuTracer-windows-x64.zip` from
the `native-windows-x64` artifact of a [CI run](https://github.com/pissang/mutracer/actions/workflows/ci.yml).
Extract the whole archive and open `mutracer-viewer.exe`. Windows packages are
not included in release downloads.

## Build and open

Install Rust, CMake, a C++20 compiler, project npm dependencies and scriptc
**0.3.2**, then run from the repository root. Linux also needs patchelf and
X11/Wayland development libraries. Experimental Windows build prerequisites are
in the [contributor guide](../CONTRIBUTING.md#build-and-ci).
The first build downloads the native OIDN SDK, source and regular model
weights (about 80–95 MiB depending on platform). The app includes regular/small
models and omits the three large weight sets. Denoising needs no runtime download:

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
`.native-build/viewer/MuTracer.app` on macOS or `.native-build/viewer/MuTracer/`
on Windows/Linux. The output includes its sample and runtime libraries and can
be opened without project files or build tools. `MUTRACER_NATIVE_OUTPUT` changes
the output directory. See the [native guide](../README.md) for platform backends.

## Controls

- Drag the image to orbit; right-drag or Shift-drag to pan; scroll to zoom.
  **Fit model** or **F** restores framing.
- Use the left **Scene** list to search and select objects, or click a surface in
  the viewport to open its **Material** panel. **Frame selection** fits the camera
  to that object. The right **Object** panel provides world position, local Y
  rotation and uniform scale controls. Each edit
  affects the selected object; objects sharing its geometry move independently.
- Select a material and edit base color, roughness, metalness or transmission.
  Edits affect every object sharing that material. Picking tests geometry, so
  transparent surfaces can be selected ahead of objects behind them.
  Imported base-color, normal, metallic/roughness and emissive maps remain active.
- Choose **Lighting**, **Material**, **Camera**, **Render** or **Object** on the
  right rail. Click the active category to hide the inspector; **[** and **]**
  toggle the scene list and inspector. Click section headings to collapse their
  settings. Narrow windows hide the scene list to preserve viewport space.
- Adjust environment intensity, tint, rotation and background visibility.
  **Load HDR…** opens a local Radiance equirectangular environment; **Studio**
  restores the built-in light.
- Choose sample count and resolution, pause/resume, restart accumulation, adjust
  exposure or save the displayed image as PNG. The preview uses Reinhard/sRGB.
- **Lighting** also provides an optional directional **Key light**, disabled by
  default. Adjust its intensity, color, azimuth and elevation.
- **Native OIDN** is on by default. It denoises completed previews after interaction
  pauses, trying Metal, then CUDA, then HIP, then CPU. CUDA requires a supported
  NVIDIA GPU and driver; HIP requires a supported AMD GPU and compatible AMD
  driver/HIP runtime. Other devices fall back to CPU. Toggle it to compare
  the unfiltered image; PNG export uses the currently displayed result.
- **Ray tracing** defaults to **HWRT**, with **Software** as the other option.
  Unsupported devices and acceleration-structure limits or allocation failures
  fall back to Software. The panel reports the actual path, fallback reason and
  the number of geometries using a software BVH.

Camera changes restart accumulation while retaining the scene. The previous
image remains visible until a newer preview arrives, including while dragging.
Basic color, roughness, metalness and transmission edits retain the scene's
geometry and textures and restart accumulation. Environment intensity, tint and
rotation also retain the scene when map dimensions and background mode stay the
same. Key-light color, intensity and direction edits retain the scene as well.
Object transforms retain vertices and textures; changes to resource sizes
require a rebuild.
Loading a different-sized HDR, switching background mode, changing shader
features or unlit materials, and changing resolution rebuild the scene. Moving
between zero and nonzero light or environment intensity can also require a
rebuild. Full rebuilds run in the background while the previous image stays visible.
Changes are combined at roughly 120 ms intervals while held, then applied when
released. CPU/GPU contention can still reduce responsiveness.
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
Rendering uses wgpu with six bounces. HWRT support and fallbacks follow
[the native intersection limits](../README.md#intersection-backend).
HWRT has an unresolved intermittent whole-scene miss on macOS/Metal; choose
Software when image correctness is critical. Coplanar overlapping surfaces can
also look different between the two backends. Device-loss recovery is not
implemented.
Native OIDN output can differ from browser OIDN output. Custom OIDN model
weights are not supported by this example.
