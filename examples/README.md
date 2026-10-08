# Examples

```bash
npm install
npm run dev
```

Then open <http://localhost:3001/examples/>.

| Example | Shows |
| --- | --- |
| [`basic`](./basic.ts) | Minimal setup: `Renderer`, `Mesh`, `OpenPBRMaterial`, `RectLight`, `EnvironmentLight`, `CameraViewControl` and the render loop. |
| [`three`](./three.ts) | Building the scene in Three.js (`GLTFLoader`, `OrbitControls`, `MeshPhysicalMaterial`) and rendering it with `THREESceneSync` / `fromTHREECamera`; rotation and a roughness slider for incremental material edits. |
| [`animation`](./animation.ts) | A procedural skinned cylinder, bone animation and a morph slider; pause animation to accumulate a clean image. Both backends support `?webgl`. |
| [`advanced`](./advanced.ts) | Coat, transmission with dispersion, subsurface, fuzz and thin-film materials; a shadow catcher with a transparent background; `setDenoiser()`; `renderOfflineFrame()` and PNG export. |

The examples import `claypt`, which the dev server aliases to `src/`. All
assets are procedural or generated: [`assets/chess.glb`](./assets/chess.glb)
comes from [`scripts/create-example-model.mjs`](../scripts/create-example-model.mjs)
(CC0) and the sky is built in [`shared/sky.ts`](./shared/sky.ts).
