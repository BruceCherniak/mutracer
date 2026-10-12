# MuTracer Viewer

A browser app for trying MuTracer: drop a glTF/GLB (or a folder with a .gltf,
its .bin and textures) or a Radiance .hdr, browse the scene tree, edit OpenPBR
materials, lighting, camera and render settings, play glTF animations and
export PNGs.

The Export dialog can download the current viewport PNG immediately, preserving
its displayed appearance and pixel size without restarting the render. Render PNG
instead renders a new image at Viewport, 1080p, 2K (2560 × 1440), 4K, or Square
resolution using the selected sample count and background settings.

```bash
npm run viewer          # http://localhost:3012
npm run build:viewer    # static site in dist-viewer/
npm run typecheck:viewer
npm run test:viewer       # source aliases; no prior build:lib needed
```

Add `?webgl` to force the WebGL 2 backend. The URL hash keeps the example
model, lighting (environment or studio preset), exposure and tone mapping, so a
view can be shared.

## Deployment

The viewer is deployed under `/viewer/` of the MuTracer site, together with
the home page and the examples. See [`site/README.md`](../site/README.md).

## Structure

```
src/
  engine/ViewerEngine.ts   Engine/Display/Render, THREESceneSync, picking,
                           animation, export. No React.
  engine/loadModel.ts      GLTFLoader for URLs, files and dropped folders;
                           the procedural material-sphere scene
  engine/environment.ts    Procedural sky, HDR loading, baked intensity/rotation
  engine/studio.ts         Studio lighting presets: rect-light rigs scaled to
                           the model, and their dim ambient fill
  engine/materialParams.ts Material panel schema, presets, color conversion
  engine/materialEditor.ts Material edits, uploaded textures and their
                           persistence for the cached model
  history.ts               Shared undo/redo history for material, lighting
                           and render edits
  engine/presets.ts        Example models and HDRIs with licenses
  assets/thumbnails/       Example and material preset thumbnails
  dev/thumbnails.ts        Renders those thumbnails (development only)
  store.ts                 zustand store: settings, stats, tree, selection, UI
  components/              React UI (react-aria-components, lucide-react)
  styles/app.css           Design tokens and component styles
```

Data flows one way: controls write `store.settings`; `ViewerEngine`
subscribes, applies the change to the renderer, the Three.js source scene or
the converted `OpenPBRMaterial`s, and publishes stats, the scene tree and the
selection back to the store.

Notes:

- Material edits go to the converted MuTracer `OpenPBRMaterial`s (collected with
  `onMeshConverted`), followed by `markUpdated()`. The Three.js source material
  is not touched, so the scene sync does not overwrite the edit.
- Material edits (values, presets, texture uploads and removals, reset) and
  lighting and render settings changed through `setSettings` share one undo
  history; consecutive changes of one slider or color picker collapse into one
  step. Camera settings, which follow the view, and switches to or from an
  uploaded .hdr are not recorded. Opening a model drops its material steps and
  keeps the settings steps.
  Uploaded images are decoded like GLTFLoader (no premultiplication or color
  space conversion) and keep the UV transform of the texture they replace.
- Material edits of the cached model, including the original files of uploaded
  textures, are saved in a second OPFS archive keyed by the model and by each
  material's traversal order. Reloads reapply them as materials are converted;
  opening any model (including choosing the same example again) discards them
  and the undo history.
- `EnvironmentLight` has no intensity or rotation, so both are baked into a copy
  of the HDR pixels.
- Downloaded HDR files are cached by URL (including resolution and query string)
  in the browser's origin private file system (OPFS), and reused across reloads.
  Invalid cached files are downloaded again; unavailable or full storage falls
  back to normal loading. Clear the site's browser storage to remove the cache.
- The current model and its buffers/textures are saved as one OPFS archive,
  replacing the previous model after a successful load. Reloads reopen that
  model; an explicit model preset in the URL takes precedence. Orbit position,
  target and lens settings are saved locally for the current model and restored
  after loading, including the selected glTF camera. Unavailable/full storage
  does not prevent opening models.
- Denoising defaults to OIDN on WebGPU and falls back to JNLM on WebGL 2.
  Switch between OIDN and JNLM in the bottom dock or the Render tab; each keeps
  its parameters, and the selected filter is saved across reloads.
- OIDN weights are loaded from `/oidn/weights/` at the server root via an explicit
  weightsBaseUrl, sharing all five local networks. Development serves the
  repository's `oidn/weights/` there, `build:viewer` emits them at the root of
  `dist-viewer/`, and the site build shares one copy with the examples.
- Opening the viewer with `#open=files` loads files that the home page stashed
  in IndexedDB (`engine/droppedFiles.ts`).
- All example-model previews are managed in the independent
  [mutracer-assets](https://github.com/pissang/mutracer-assets) repository, including
  Material spheres, Toy Car and Sheen Chair. They use 720 × 405 WebP (quality 80%),
  Studio Light and OIDN standard; their saved cameras also apply on fresh loads.
  Render and review them through that repository's import pipeline. The viewer's
  `await generateThumbnails()` console tool only generates local material swatches
  in `src/assets/thumbnails/` (checker cyclorama, dimmed environment light).
- The visual language comes from DropMesh (same author).

## Assets

GLBs from the independent assets pipeline may provide a default orbit camera
in the active glTF scene's `extras.mutracerCamera`: `{position: [x,y,z], target:
[x,y,z], fov: 45, space: "grounded"}`. Coordinates refer to the model after the
viewer centers X/Z and grounds Y. Fresh loads apply this view; a restored saved
user view takes precedence. Invalid camera metadata falls back to automatic fit.

Example models are loaded on demand. Material spheres are procedural; Toy Car
and Sheen Chair come from [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
(CC0). All nine examples use the public selection in
[mutracer-assets](https://github.com/pissang/mutracer-assets). Their metadata is
copied from that repository's `presets.json` into `engine/publicModelPresets.ts`;
Downloaded GLBs and all model previews stay in the assets repository or R2.
The three original samples share the review list; their procedural/Khronos model
sources are preserved and only their previews/credits are hosted there. GitHub downloads are
pinned to `v0.1.0`, published with the resources before deployment.
When publishing a new asset release, update this metadata and its pinned version
together. R2 permits browser reads from the production site only.

The sample site is a free, noncommercial technical demonstration. Each Sketchfab
asset retains its own CC BY, CC BY-NC or CC BY-NC-SA 4.0 license, displayed with
author, source, license and full credits/change notes; these assets are not
covered by the library's MIT license. Yamaha and Gelatinous Cube require
noncommercial use, and Yamaha adaptations retain ShareAlike. Jaguar and the
octopus remain local previews and are excluded from the public list. HDRIs come
from [Poly Haven](https://polyhaven.com/hdris) (CC0). The material spheres and the
procedural sky work offline.
