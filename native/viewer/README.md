# MuTracer native viewer

A standalone glTF/GLB viewer built on the [native SDK](../README.md). It runs
without a browser, JavaScript engine or Node.

## Download

| Platform | Archive | Open |
| --- | --- | --- |
| macOS arm64 | `MuTracer-macos-arm64.zip` from [GitHub Releases](https://github.com/pissang/mutracer/releases) | `MuTracer.app` |
| Linux x64 | `MuTracer-linux-x64.tar.gz` from [GitHub Releases](https://github.com/pissang/mutracer/releases) | `mutracer-viewer` |
| Windows x64 | `MuTracer-windows-x64.zip` from the `native-windows-x64` artifact of a [CI run](https://github.com/pissang/mutracer/actions/workflows/ci.yml) | `mutracer-viewer.exe` |

Extract the whole archive and keep its files together: the executable, sample, bundled libraries and
licenses. Each archive has a SHA-256 checksum file.

- macOS: the app is ad-hoc signed and not notarized by Apple.
- Linux: targets Ubuntu 24.04 and needs a Vulkan driver and an X11 or Wayland
  desktop. X11 sessions also need `libxkbcommon-x11-0`.

## Build from source

Install the [SDK build requirements](../README.md#build-and-link).
Linux also needs the X11/Wayland development libraries; Windows
needs the [contributor setup](../CONTRIBUTING.md#windows). Then, from the
repository root:

```bash
npm ci
npm ci --prefix native/toolchain --include=optional
export MUTRACER_SCRIPTC="$(node native/toolchain/compiler.mjs)"
npm run native:viewer
```

Add `-- /absolute/path/model.glb` to open a model at launch.
`npm run native:viewer:build` builds without opening the app, into
`.native-build/viewer/MuTracer.app` on macOS or `.native-build/viewer/MuTracer/`
on Windows and Linux (`MUTRACER_NATIVE_OUTPUT` changes the directory). The
result runs without project files or build tools.

The app includes the oidn-webgpu runtime and standard model. It needs no
denoising download or OIDN SDK at runtime.

## Use

### Files and window

- The app opens with a procedural sample. Use **Open…** (**⌘O** / **Ctrl+O**)
  or drop a `.gltf` or `.glb` file anywhere in the window. Keep external `.bin`
  files and images beside their `.gltf`. While loading, the previous model stays
  visible; a failed load shows an error and keeps it.
- **Export…** saves a PNG.
- Drag empty space in the top bar to move the window and double-click it to
  zoom. The three window buttons close, minimize or zoom; the bottom-right grip
  resizes.
- The right rail opens **Lighting**, **Material**, **Camera**, **Render** and
  **Object**; click the active category to hide the inspector. **[** and **]**
  toggle the scene list and inspector. Section headings collapse. Narrow windows
  hide the scene list.
- Sliders and numeric fields are separate. Drag a numeric field left or right,
  or click it to type; Enter or clicking elsewhere commits and Escape cancels.

### Camera

- Drag to orbit, right-drag or Shift-drag to pan, scroll to zoom. **Fit to
  model** or **F** restores the framing.
- Choose perspective (35° default field of view) or orthographic projection.
- Perspective views support depth of field: enable it and choose an f-number.
  **Area autofocus** is on by default; drag the focus frame's center to choose
  the target. It focuses once the view settles and keeps the current distance
  when the area is empty. Adjusting **Focus (m)** switches to manual focus, and
  **Pick focus point** then focuses on a clicked surface.
- Set the scene unit to match the model (default metres).
- Projection, field of view, f-number and scene unit persist across models.

### Objects

- Search and select objects in the left **Scene** list, or click a surface in
  the viewport to open its material. **Frame selection** fits the camera to the
  object.
- The **Object** panel edits world position, local Y rotation and uniform scale
  of the selected object. Objects that share its geometry stay in place.
- Picking and autofocus can hit transparent or cutout surfaces in front of other
  objects.

### Materials

- Groups: **Base**, **Transmission**, **Coat**, **Subsurface**, **Fuzz**,
  **Thin film**, **Emission** and **Advanced**. Inactive layers start collapsed.
- Presets: choose **Basic**, **Metal**, **Glass** or **Soft**, then a thumbnail,
  to apply one of the web viewer's 32 presets. Presets keep textures and
  displacement and turn off layers they do not use.
- Edits apply to every object that shares the material. **Opacity** applies in
  Auto, Mask or Blend alpha mode; normal scale needs a normal map.

**Textures** (under **Material → Textures**):

- Click a swatch or drop a PNG, JPEG or WebP image onto a slot to upload or
  replace it; **×** removes it. Slots match the web viewer: base color, combined
  metal/rough, roughness, metalness, normal, displacement, emission,
  transmission and thin film. Each slot shows its channel use and actual image
  size.
- A replacement keeps the slot's UV settings, or takes the base color map's
  settings when the slot was empty.
- **Wrap & repeat** sets **Wrap S/T** to Repeat, Clamp to edge or Mirrored
  repeat. A negative **Repeat S/T** flips an axis; zero samples a constant
  coordinate.

**Poly Haven** (**Browse Poly Haven textures**):

- Search the CC0 catalog, filter by category and download 1K, 2K or 4K sets
  (about 3, 12 or 45 MB). A set replaces the color, normal and
  roughness/metalness maps and resets other material layers.
- **Download displacement map** is off by default; leaving it off clears the
  previous displacement map.
- A set applies once all maps finish; a failed or cancelled download keeps the
  previous textures. A new pick cancels the previous download, and opening
  another model cancels it. Closing the browser lets a download finish on its
  original material.

**Displacement**:

- Height is `texture × Scale + Bias` in mesh-local units and works on both ray
  tracing backends. A displacement map is required.
- Projection: UV, Triplanar, Spherical or Cylindrical. Meshes without UVs use
  Triplanar when a displacement map is uploaded.
- **Step size** 0 is automatic; smaller positive values render more slowly.
  Displacement increases preparation and render time.

### Lighting and background

- **Environment**: intensity, tint and rotation. **Load HDR…** opens a local
  Radiance equirectangular map; **Built-in** restores the default map.
- **Studio**: eight softbox presets with intensity, rotation, size, ambient fill
  and ambient color. Lights follow the model's bounds; larger softboxes give
  softer shadows at about the same exposure. Changing the preset takes longer
  than adjusting the lights. Switching to Studio and back keeps the selected
  environment.
- **Key light**: an optional directional light, off by default, with intensity,
  color, azimuth and elevation.
- **Background**: Environment, Color or Transparent, in either lighting mode.
  A transparent background keeps the lighting and exported PNGs keep alpha. In
  Studio, the Environment background shows the ambient fill.

### Rendering

- The floating toolbar shows progress and samples, with pause/resume, restart,
  maximum samples, **Res** and denoise controls; its settings button opens
  **Render**. **Space** pauses or resumes models without animation; **D**
  toggles denoising.
- Interaction renders a lower-resolution preview. When input stops, the image
  converges at the selected resolution and settings. Sample counts, denoising
  and export use that final image; export is available after one complete
  sample. Pausing keeps the last image.
- **Res**: 25%, 50% (default), 75% or 100% of the viewport's pixel size,
  including display scaling up to 2×, updated after resizing settles; or a
  fixed 720p, 1080p, 2K or 4K. The menu shows the output size, which PNG export
  uses. 100% renders four times the pixels of 50% and uses more memory.
- **Render** panel: 4–4096 maximum samples, 1–16 bounces (default 6), Sobol,
  Z-Sobol or Random sampling, and clamping (0 disables it). These restart
  rendering; more samples and bounces take longer.
- **Color**: AgX (default), ACES, Cineon, Reinhard or Linear tone mapping,
  exposure (1 is unchanged), contrast, saturation, temperature and tint, for
  both preview and export. **Output** selects Final, Normal or Albedo; guide
  channels skip color controls and denoising.
- **Denoise** is on by default. It denoises final samples after
  interaction pauses, using [oidn-webgpu](../docs/denoising.md#oidn-webgpu)
  on the rendering GPU. Toggle it to compare;
  export uses the latest denoised result when there is one.
- **Ray tracing**: **HWRT** (default) or **Software**. The panel shows the path
  in use, any fallback reason and how many geometries use a software BVH.

### Animation

- Animated models show a timeline in the toolbar. The first clip starts paused
  at time zero, at 1× with **Loop** on.
- Play/pause with its button or **Space**; drag the timeline to pause at a
  time; select another clip to start it from the beginning. Speeds are 0.25×,
  0.5×, 1× and 2×. Without looping, playback stops at the end and playing again
  restarts the clip.
- Pausing rendering also pauses playback; playing a clip resumes rendering.
  Each new pose restarts accumulation, so pause the animation to let the image
  converge and denoise. Deforming large meshes can slow playback.

### Responsiveness

- Camera moves, basic material edits (color, roughness, metalness,
  transmission), environment intensity, tint and rotation, key light edits and
  object transforms keep the prepared scene and only restart accumulation. The
  previous image stays until a newer preview arrives.
- A different-sized HDR, a background mode switch, shader feature or unlit
  changes, moving a light or the environment between zero and nonzero
  intensity, and resource size changes rebuild the scene in the background
  while the previous image stays visible.
- Color controls, the output channel and denoising change only the displayed
  image.
- During continuous edits, new input waits for the current frame and any scene
  preparation, then applies the latest state. CPU or GPU contention can still
  slow interaction; a lower resolution helps, and no frame rate is guaranteed.
- The first denoise can be slower than later ones. A result for an older scene,
  camera or sample count never replaces the current preview.

## Limits

- Models follow the SDK's [glTF import support and limits](../docs/gltf.md).
- Uploaded and downloaded textures can be up to 4,096 pixels per side and
  shrink to share a 12M-pixel material budget; slot sizes show what is used.
  Displacement images are resized to a square power of two. HDR environments
  are limited to 4M pixels.
- HWRT can occasionally drop a sample on macOS; choose Software when exact
  output matters. Coplanar overlapping surfaces can differ between backends.
  See [ray tracing backends](../README.md#ray-tracing-backends).
- Device-loss recovery is not implemented.
- Denoising output can differ from browser OIDN. Custom weights are not exposed
  in the viewer.
