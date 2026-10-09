# ClayPT Viewer

A browser app for trying ClayPT: drop a glTF/GLB (or a folder with a .gltf,
its .bin and textures) or a Radiance .hdr, browse the scene tree, edit OpenPBR
materials, lighting, camera and render settings, play glTF animations and
export PNGs.

```bash
npm run viewer          # http://localhost:3012
npm run build:viewer    # static site in dist-viewer/
npm run typecheck:viewer
```

Add `?webgl` to force the WebGL 2 backend. The URL hash keeps the example
model, environment and its resolution, exposure and tone mapping, so a view can be shared.

## Cloudflare deployment

From the repository root, with Node.js 20 or later:

```bash
npm ci
npx wrangler login      # once per machine
npm run deploy:viewer
```

`wrangler.jsonc` checks the viewer's types, builds it and deploys `dist-viewer/`
as static assets for the `claypt-viewer` Worker. Wrangler prints the public
HTTPS URL after deployment. No server code or runtime secrets are needed.
The build includes the TinyBVH/Draco WebAssembly files and local OIDN weights.
Only fingerprinted files under `assets/` receive an immutable browser cache.
Viewer state uses the URL hash, so missing asset URLs return 404.

For Cloudflare Workers Builds, use `npm run build:viewer` as the build command
and `npm run deploy:viewer` as the deploy command (the latter also rebuilds
and checks types).

## Structure

```
src/
  engine/ViewerEngine.ts   Renderer, render loop, THREESceneSync, picking,
                           animation, export. No React.
  engine/loadModel.ts      GLTFLoader for URLs, files and dropped folders;
                           the procedural material-sphere scene
  engine/environment.ts    Procedural sky, HDR loading, baked intensity/rotation
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

- Material edits go to the converted ClayPT `OpenPBRMaterial`s (collected with
  `onMeshConverted`), followed by `markUpdated()`. The Three.js source material
  is not touched, so the scene sync does not overwrite the edit.
- `EnvironmentLight` has no intensity or rotation, so both are baked into a copy
  of the HDR pixels.
- OIDN weights are served from the repository's `oidn/weights/` at the server
  root in development (this also works when the examples server serves the
  viewer at `/viewer/`) and copied next to `index.html` in the build, because
  the CDN copy only exists for published versions.
- The Examples menu and material preset thumbnails are ClayPT renders. After
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
