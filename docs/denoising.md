# Denoising

MuTracer has two denoisers. Both filter the complete composed image using
albedo and normal guides.

- **JNLM** (default): a built-in joint non-local means filter, on WebGPU and
  WebGL 2. It needs no weight download.
- **OIDN**: [Intel Open Image Denoise](https://www.openimagedenoise.org/)
  networks, run through [`oidn-web`](https://www.npmjs.com/package/oidn-web),
  WebGPU only. They take longer and need weights, but are cleaner at one or
  two samples per pixel, for example for denoising while the camera moves.

```ts
const engine = new Engine({canvas});
const final = new Render(engine, {denoiser: {type: 'jnlm'}});
final.denoiser = {type: 'oidn', model: 'standard'};
final.denoiser = null; // disable
```

`type` defaults to jnlm, or oidn when model or weightsBaseUrl is supplied.
Each render has its own configuration and scheduling. Converge waits for its
configured filter; intermediate progressive inference reports converging and
final inference reports denoising. Engine caches equal network configurations
and weights, releasing the network after its last render lease is released.

OIDN is loaded lazily. On WebGL its configuration warns and leaves this render
unfiltered; JNLM works on both backends. Current loading and inference failures
are reported through engine error events. Replaced/disposed network prewarm
results are discarded.

## Options

| `DenoiserOptions` | Description |
| --- | --- |
| `type` | `'jnlm'` or `'oidn'`. Default `'jnlm'`, or `'oidn'` when `model` or `weightsBaseUrl` is given |
| `strength` | JNLM filter strength. Default `1` |
| `searchRadius` | JNLM search radius, integer `1–16`. Default `5` (11 × 11 window) |
| `patchRadius` | JNLM color comparison patch radius, integer `0–3`. Default `1` (3 × 3 patch) |
| `albedoBandwidth` | JNLM relative albedo tolerance, `0.0001–10`. Default `0.4` |
| `normalBandwidth` | JNLM encoded normal tolerance, `0.0001–10`. Default `0.05` |
| `iterations` | JNLM filter passes, integer `1–4`. Default `2` |
| `model` | OIDN network: `'standard'`, `'small'` or `'cleanAuxLarge'` |
| `weightsBaseUrl` | Directory containing the OIDN `.tza` files |
| `schedule` | `'converged'` (default), `'progressive'`, or `'every-sample'` |
| `maxTileSize` | Maximum OIDN tile size; chosen by oidn-web by default |
| `signal` | `AbortSignal` for the OIDN weight download |

## OIDN models

| `model` | Weights | Use |
| --- | --- | --- |
| `'standard'` (default) | `rt_hdr_alb_nrm.tza` (1.8 MB) | Balanced quality and speed; bundled with mutracer |
| `'small'` | `rt_hdr_alb_nrm_small.tza` (0.6 MB) | Fastest; previews while converging; bundled with mutracer |
| `'cleanAuxLarge'` | `rt_hdr_calb_cnrm_large.tza` + `rt_alb_large.tza` + `rt_nrm_large.tza` (22 MB) | Highest quality; prefilters guides; from oidn-weights@2.3.0-1 |

## Hosting the weights

Standard and small load from your application's own build assets by default.
Vite and webpack 5 copy the package's static weight URLs into the output.
In Vite development add `optimizeDeps: { exclude: ['@meimu/mutracer'] }` to avoid
prebundling asset URLs; otherwise MuTracer warns once and falls back to
jsDelivr's copy for the installed MuTracer version. The standalone `dist/`
library bundles use that CDN copy directly.

The large beauty network and auxiliary prefilters default to
`https://cdn.jsdelivr.net/npm/oidn-weights@2.3.0-1/`. To self-host all networks,
install `oidn-weights@2.3.0-1` and copy `node_modules/oidn-weights/*.tza` to a
static directory. If you only use standard/small, copying the two files from
`node_modules/@meimu/mutracer/oidn/weights/` is sufficient:

```ts
final.denoiser = {type: 'oidn', weightsBaseUrl: '/assets/oidn/weights/'};
```

Explicit URLs never fall back to the CDN. Every download is checked for the
TZA file signature. The weights use Apache-2.0 (`oidn/weights/LICENSE.txt`).

## Scheduling

```ts
final.denoiser = {type: 'oidn', model: 'standard', schedule: 'progressive'};
preview.denoiser = {type: 'oidn', model: 'small', schedule: 'every-sample'};
```

Converged filters the final sample budget. Progressive filters sample 1,
then 4, 8, 16, … and the final budget, with a ten-second limit between
updates. Every-sample filters every complete sample of its render. Coalescing
continuous scene/camera edits is application loop policy; the engine accepts
edits only when update is called. See [progressive rendering](./progressive-rendering.md).

## Tuning JNLM

`strength` (default `1`) scales the color tolerance. Higher values remove
more noise at low sample counts and more detail at high ones.

```ts
final.denoiser = {type: 'jnlm', strength: 1.5};    // filter more
```

JNLM settings are available through `DenoiserOptions`. Omitted settings use
the exported `DEFAULT_JNLM_OPTIONS`; `JNLMOptions` is the corresponding type.
Assigning `render.denoiser` applies a fresh configuration to the existing sample
accumulation, so include the settings you want to retain on each call.

```ts
import { DEFAULT_JNLM_OPTIONS } from '@meimu/mutracer';

final.denoiser = {
  type: 'jnlm',
  ...DEFAULT_JNLM_OPTIONS,
  strength: 1.2,
  searchRadius: 7,
  albedoBandwidth: 0.3
};
```

Larger search windows cost more but find more matching neighbors. Smaller
patches preserve small color details. Lower albedo and normal tolerances
reject more neighbors, protecting detail while retaining more noise. Extra
passes remove broader noise patches and can soften detail. Invalid parameters
reject before replacing the active filter. These settings work on both WebGPU
and WebGL 2; OIDN ignores JNLM settings.

## Lower-level OIDN loading

The `/oidn` entry exposes initializeOIDN(engine, options) and
initializeOIDNFromURL(engine, url, options). They initialize the engine, create
and return a network without attaching it. The caller owns disposal. They
require WebGPU. Render.denoiser currently accepts built-in configurations.

## Implementation notes

### How JNLM works

The weights follow Rousselle, Manzi and Zwicker, *Robust Denoising using
Feature and Color Information* (2013). Each pixel starts with a weighted mean of
its 11 × 11 neighborhood. A neighbor's weight is the smaller of:

- a color weight: the distance between the two pixels' 3 × 3 patches,
  normalized by their estimated variance, so differences explained by noise
  are ignored;
- a feature weight: the albedo, coverage and normal differences, which keep
  texture and geometric edges.

Albedo differences are measured relative to each channel's local brightness,
with a small floor near black. This protects low-contrast dark textures as
well as brighter ones. Coverage and encoded normals use absolute differences.

The mean is corrected by a local linear fit between each RGB channel and its
albedo channel, using the same weights. This preserves subtle texture while
averaging lighting noise. A small regularizer stabilizes nearly constant
guides, and the fitted response is bounded between zero and multiplicative
albedo modulation. Constant albedo keeps the weighted mean; unrelated albedo
does not automatically get transferred into the image. Alpha and the
luminance matching guide retain their weighted-mean estimates.

A second pass filters the result again with every other pixel (à-trous),
which removes the blotches a single pass leaves at the scale of its window.

The variance comes from per-pixel luminance moments that the path tracer
accumulates alongside the color. Weights are computed in linear radiance and
applied to the composed image, including its alpha, so shadow catchers and
transparent backgrounds are filtered too. Pixels that show the background
directly are left as rendered.

While-converging intermediate denoise batches report `'converging'`. Only denoising the final image at `maxSamples` reports `'denoising'`; `'finished'` means that final image is ready.
