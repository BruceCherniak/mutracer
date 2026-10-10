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
  engine/ViewerEngine.ts   Renderer, render loop, THREESceneSync, picking,
                           animation, export. No React.
  engine/loadModel.ts      GLTFLoader for URLs, files and dropped folders;
                           the procedural material-sphere scene
  engine/environment.ts    Procedural sky, HDR loading, baked intensity/rotation
  engine/studio.ts         Studio lighting presets: rect-light rigs scaled to
                           the model, and their dim ambient fill
  engine/materialParams.ts Material panel schema, presets, color conversion
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
- The Examples menu and material preset thumbnails are MuTracer renders. After
  changing a preset, run `await generateThumbnails()` in the browser console
  of `npm run viewer`; the dev server saves them to `src/assets/thumbnails/`.
  The material stage (checker cyclorama, dimmed studio light) follows
  DropMesh's material previews.
- The visual language comes from DropMesh (same author).

## Assets

Nothing large is committed. Example models are loaded at run time from the
[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
(CC0 or CC-BY 4.0, credited in the viewport) and HDRIs from
[Poly Haven](https://polyhaven.com/hdris) (CC0). The material spheres and the
procedural sky work offline.
