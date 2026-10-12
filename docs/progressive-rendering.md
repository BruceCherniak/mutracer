# Independent render results

Create one `Engine` for a scene and camera, then one `Render` per output. The
engine owns shared GPU scene data; a render owns its image and complete sample
count. `Display` owns canvas presentation and display settings.

```ts
import { Engine, Render } from '@meimu/mutracer';
const engine = new Engine({ canvas });
engine.scene = scene;
engine.camera = camera;
const preview = new Render(engine, {
  resolutionScale: .5,
  adaptiveResolution: { targetFrameMs: 20, minScale: .25 },
  bounces: 2, bevel: false, dispersionWavelengths: 1,
  directLightCandidates: 2,
});
const final = new Render(engine, { fallback: preview });
function frame() {
  engine.update();
  const current = dragging ? preview : final;
  current.refine();
  engine.display.present(current);
  requestAnimationFrame(frame);
}
frame();
```

`engine.update()` is the only external edit detection and commit point. Until
it runs, object edits and scene/camera replacement have no effect on tracing.
Call it once after updating your scene and controls, even when several renders
are refined that frame. See [scene updates](updates.md) for notifications.

## Reading and exporting

A fixed-size render does not need to be displayed. Its camera defaults to the
committed engine camera, with automatic aspect based on its target dimensions.
An explicitly supplied camera aspect is preserved.

```ts
const image = new Render(engine, { width: 256, height: 256 });
engine.update();
await image.converge({ samples: 64, sampleSequenceOffset: 0 });
const hdr = await image.readPixels('hdr'); // this image, regardless of other activity
const blob = await engine.display.toBlob(image);
image.dispose();
```

`toBlob` uses the specified render's actual dimensions and the display's
settings. It does not resize or change the display canvas. `converge` accepts a
camera override, copied on entry, without replacing `engine.camera`. If engine
input revisions change during a convergence task, the task rejects. Only that
render rejects `refine()` while convergence is running; other renders remain
usable.

## Options and ownership

- Engine: backend, scene/camera, BVH preparation and texture atlas budget.
- Display: size, tone mapping, color grading, bloom, HDR output, channel and
  shadow-catcher color/opacity. Editing these does not restart accumulation.
- Render: resolution, samples, path quality, alpha handling, execution budget,
  fallback and denoiser. `transmissiveOutputAlphaMin` belongs to Render because
  it is evaluated along individual paths, so changing it restarts that render.

The default render scale is 1 and adaptive resolution is disabled. Alternatively,
provide both fixed width and height at construction; fixed dimensions cannot be
changed through `resolutionScale`. `width` and `height` report the actual GPU
image, including WebGPU's 16-pixel alignment. See [API options](api.md).

Assign `render.denoiser = { type: 'jnlm', schedule: 'converged' }` or an OIDN
configuration. The schedules are `converged` (default), `progressive` (first
sample, then 4, 8, 16, … with a ten-second limit), and `every-sample`. Same-engine
renders share equal filter configurations and OIDN weight downloads. The engine
releases a network when its last render lease is released. OIDN is ignored with
a warning on WebGL; JNLM works on both backends.

## Caveats

A fallback has only one level and must belong to the same engine. If the first
full sample is predicted to exceed the frame budget, `refine` supplies a sample
to a stale fallback before continuing. A current fallback is reused; a fast
final sample does not render the fallback. `present` selects the requested
complete image, then its complete fallback, and otherwise leaves the canvas
unchanged. It never traces.

`prepare(nextScene)` performs optional CPU BVH preparation without disturbing
the current GPU scene. Setting `engine.scene` and calling `update` commits a
scene switch for every render. Only one GPU scene resides in an engine.

Dispose renders when no longer needed; `engine.dispose()` releases every render
and shared resource. Initialization and asynchronous filter failures use the
engine's `error` event. `Render.status` is independent for each output; the
first-layer API leaves frame selection and application UI status to the caller.
