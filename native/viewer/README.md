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

- Drag empty space in the top bar to move the window; double-click it to zoom.
  The three window buttons close, minimize or zoom; drag the bottom-right grip
  to resize. **Open…** or **⌘O / Ctrl+O** opens a model, and **Export…** saves the image.
- Drag the image to orbit; right-drag or Shift-drag to pan; scroll to zoom.
  **Fit to model** or **F** restores framing. **Camera** offers perspective and
  orthographic projection, with a 35° default field of view. Perspective views
  support depth of field: enable it and choose an f-number. **Area autofocus**
  is on by default; drag the focus frame's center to choose its target. It focuses
  after the view settles and keeps the current distance when the area is empty.
  Adjusting **Focus (m)** switches to manual focus; **Pick focus point** then
  focuses on a clicked surface. Choose the scene unit to match the model; it
  defaults to metres. Projection, field of view, f-number and scene unit persist
  when opening another model. Orthographic views have no depth of field.
- Sliders and numeric fields are separate. Drag a numeric field left or right
  to adjust it, or click it to type. Enter or clicking elsewhere commits typed
  edits; Escape cancels them. Text dragging selects text while editing.
- Use the left **Scene** list to search and select objects, or click a surface in
  the viewport to open its **Material** panel. **Frame selection** fits the camera
  to that object. The right **Object** panel provides world position, local Y
  rotation and uniform scale controls. Each edit
  affects the selected object; objects sharing its geometry move independently.
- The **Material** panel provides **Base**, **Transmission**, **Coat**,
  **Subsurface**, **Fuzz**, **Thin film**, **Emission** and **Advanced** groups.
  Choose **Basic**, **Metal**, **Glass** or **Soft**, then click a thumbnail to
  apply one of the same 32 presets as the web viewer. Presets keep textures and
  displacement settings and turn off layers they do not use. Inactive layers
  start collapsed; open a heading to edit their parameters.
  Edits affect every object sharing that material. **Opacity** applies in Auto,
  Mask or Blend alpha mode; normal scale requires a normal map.
  Picking and autofocus can target transparent or cutout surfaces ahead of
  objects behind them.
- Choose **Lighting**, **Material**, **Camera**, **Render** or **Object** on the
  right rail. Click the active category to hide the inspector; **[** and **]**
  toggle the scene list and inspector. Click section headings to collapse their
  settings. Narrow windows hide the scene list to preserve viewport space.
- Under **Material → Textures**, click a swatch or drop a PNG, JPEG or WebP image
  onto a slot to upload or replace it; **×** removes it. Slots match the web viewer:
  base color, combined metal/rough, separate roughness and metalness, normal,
  displacement, emission, transmission and thin film. Channel hints and actual
  image dimensions appear beside each slot. Replacement keeps that slot's UV
  settings, or inherits the base-color map's settings when the slot is empty.
  Expand **Wrap & repeat** to set **Wrap S/T** independently to Repeat, Clamp to
  edge or Mirrored repeat. Negative **Repeat S/T** values flip an axis; zero
  samples a constant coordinate. Edits affect the selected material and restart
  rendering; materials sharing it change together.
- **Browse Poly Haven textures** opens a searchable CC0 catalog with category
  filters and 1K/2K/4K downloads (roughly 3/12/45 MB per set). Clicking a set
  downloads it in the background and replaces color, normal and roughness/metalness
  maps, resetting other material layers. **Download displacement map** is off by
  default; leaving it off clears the previous displacement map. A new pick cancels
  the previous request. A set applies after all maps finish; a failed or cancelled
  download keeps the previous textures. Closing the browser lets the download
  finish on its original material; opening another model cancels it.
- **Displacement** uses `texture × Scale + Bias` in mesh-local units and works on
  both native ray-tracing backends. **Step size** 0 selects an automatic step;
  smaller positive values take longer to render. Choose UV, Triplanar, Spherical
  or Cylindrical projection; meshes without UVs automatically use Triplanar for
  a newly uploaded displacement map. A displacement map is required, and edits
  can increase scene preparation and render time.
- **Lighting** switches between Environment and Studio. Environment provides
  intensity, tint and rotation; **Load HDR…** opens a local Radiance
  equirectangular map, and **Built-in** restores the built-in map. Switching to
  Studio and back preserves the selected environment.
- **Studio** offers eight softbox presets, with intensity, rotation, size,
  ambient fill and ambient color. The lights scale and move with the model's
  bounds. Larger softboxes give softer shadows while keeping roughly the same
  exposure. Changing the preset restarts rendering and can take longer than
  adjusting the lights.
- **Background** offers Environment, Color or Transparent in either lighting
  mode. A transparent background keeps the lighting, and exported PNGs retain
  alpha. In Studio, the Environment background shows the ambient fill.
- The floating render toolbar shows progress and sample count, with pause/resume,
  restart, maximum samples, **Res** and denoise controls. For models without
  animation, **Space** pauses or resumes rendering. **D** toggles denoising.
  The settings button opens **Render**.
  Interaction uses a lower-resolution preview; after input stops, the image
  converges at the selected resolution and render settings. Sample counts,
  denoising and PNG export use the final image; export is available once it has
  a complete sample. Pausing keeps the last image visible without further tracing.
- Animated models show a timeline in the toolbar. The first clip starts paused
  at time zero, at 1× speed with **Loop** enabled. Use its play button or **Space**
  to play/pause, drag the timeline to pause at a chosen time, or select another
  clip to return to its start. Speeds are 0.25×, 0.5×, 1× and 2×. With looping
  disabled, playback stops at the end; playing again restarts the clip.
  Pausing rendering also freezes playback; playing a clip resumes rendering.
  Each changed pose restarts accumulation. Pause animation to let the image
  converge and denoise. Deforming large meshes can reduce playback speed.
- **Res** offers 25%, 50% (default), 75% or 100% of the viewport's pixel size,
  including display scaling up to 2×. It updates after window or panel resizing
  settles. Fixed 720p (1280 × 720), 1080p (1920 × 1080), 2K (2560 × 1440) and
  4K (3840 × 2160) stay unchanged when resizing. The menu shows output dimensions;
  PNG export uses the selected final dimensions.
  Going from 50% to 100% renders four times as many pixels and uses more memory.
- **Render** provides 4–4096 maximum samples, 1–16 bounces, Sobol, Z-Sobol or
  Random sampling and clamping (0 disables it). Quality changes restart
  accumulation; more samples and bounces cost more rendering time. **Color**
  offers AgX (default), ACES, Cineon, Reinhard and Linear tone mapping, linear
  exposure (1 is unchanged), contrast, saturation, temperature and tint. These
  affect both preview and PNG export. **Output** selects Final, Normal or Albedo;
  guide channels bypass color controls and denoising.
- **Lighting** also provides an optional directional **Key light**, disabled by
  default. Adjust its intensity, color, azimuth and elevation.
- **Native OIDN** is on by default. It denoises completed final samples after interaction
  pauses, trying Metal, then CUDA, then HIP, then CPU. CUDA requires a supported
  NVIDIA GPU and driver; HIP requires a supported AMD GPU and compatible AMD
  driver/HIP runtime. Other devices fall back to CPU. Toggle it to compare
  the unfiltered image; PNG export uses the final image's latest denoised result
  when one is available.
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
Loading a different-sized HDR, switching background mode, or changing shader
features or unlit materials can require a rebuild. Moving
between zero and nonzero light or environment intensity can also require a
rebuild. Full rebuilds run in the background while the previous image stays visible.
Resolution changes restart accumulation. While editing, new input waits for the
current frame and any pending scene preparation, then the latest state is applied.
CPU/GPU contention can still reduce responsiveness.
Color controls, output channel and denoising change only the displayed image,
preserving the original HDR accumulation. Denoising does not block window
interaction; a result for an older scene, camera or sample count cannot replace
the current preview.
The first denoise can take longer than later runs. Choose a lower render
resolution for more responsive interaction; a fixed frame rate is not guaranteed.

## Supported inputs and limits

The example displays the default glTF scene, or the first scene if none is marked
default. Triangle meshes, strips and fans, node transforms, shared mesh
instances, RGB vertex colors, two UV sets and core metallic/roughness PBR are
supported. Missing normals and tangents are generated. Meshopt compression,
quantized geometry, WebP textures, mesh instancing, skinned meshes (up to four
joint influences) and morph targets are supported. Animation clips support node
translation/rotation/scale, skeletal motion and morph weights with STEP, LINEAR
or CUBICSPLINE interpolation. Model camera, light and material animation are not
used. Scalar transmission/IOR, unlit materials and emissive strength are also
supported.

Imported model textures are limited to 512 pixels on their longest side; models
with many images use a lower limit. Uploaded and downloaded textures can reach
4096 pixels per side and shrink as needed to share a 12M-pixel material budget.
Download resolution controls transfer size; the displayed slot dimensions show
what is actually used. Displacement images are resized to a square power of two.
Textures use repeat, clamp-to-edge or mirrored-repeat wrapping on each axis,
filtering and offset/scale UV transforms. Texture rotation and imported normal-map
UV transforms are unsupported. Imported vertex-color alpha, occlusion and transmission textures
are ignored. Transmission maps can be assigned manually in **Textures**.
Unsupported optional extensions are reported in the panel; unsupported required
extensions return an error.
Sparse quantized attributes are unsupported. Draco and Basis/KTX2 assets need
conversion before loading.

File size is limited to 128 MiB, combined model buffers to 512 MiB and source
material images to 64M pixels each, and environments to 4M pixels. The native
library imposes additional scene/texture budgets described in
[the native guide](../README.md#limits).
Rendering uses wgpu with six bounces by default. HWRT support and fallbacks follow
[the native intersection limits](../README.md#intersection-backend).
HWRT has an unresolved intermittent whole-scene miss on macOS/Metal; choose
Software when image correctness is critical. Coplanar overlapping surfaces can
also look different between the two backends. Device-loss recovery is not
implemented.
Native OIDN output can differ from browser OIDN output. Custom OIDN model
weights are not supported by this example.
