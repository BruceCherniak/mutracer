# Denoising

MuTracer has two denoisers. Both filter the complete composed image using
albedo and normal guides.

- **JNLM**: a built-in joint non-local means filter, on WebGPU and
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

`type` is required: use `jnlm` or `oidn`. The getter returns a frozen copy;
reassign the configuration to edit it. Unknown types, foreign fields and invalid
JNLM settings throw synchronously, preserving the active network and output.
Equal implementation settings share the network; changing only `schedule`
preserves active inference, and assigning an identical configuration does nothing.
Each render has its own configuration and scheduling. Converge waits for its
configured filter; intermediate progressive inference reports converging and
final inference reports denoising. Engine caches equal network configurations
and weights, releasing the network after its last render lease is released.

OIDN is loaded lazily. On WebGL its configuration warns and leaves this render
unfiltered; JNLM works on both backends. Current loading and inference failures
are reported through engine error events. Replaced/disposed network prewarm
results are discarded.

## Options

| `JNLMDenoiserOptions` | Description |
| --- | --- |
| `type` | Required: `'jnlm'` |
| `schedule` | `'converged'` (default), `'progressive'`, or `'every-sample'` |
| `strength` | JNLM filter strength. Default `1` |
| `searchRadius` | JNLM search radius, integer `1–16`. Default `5` (11 × 11 window) |
| `patchRadius` | JNLM color comparison patch radius, integer `0–3`. Default `1` (3 × 3 patch) |
| `albedoBandwidth` | JNLM relative albedo tolerance, `0.0001–10`. Default `0.4` |
| `normalBandwidth` | JNLM encoded normal tolerance, `0.0001–10`. Default `0.05` |
| `iterations` | JNLM filter passes, integer `1–4`. Default `2` |

| `OIDNDenoiserOptions` | Description |
| --- | --- |
| `type` | Required: `'oidn'` |
| `model` | OIDN network: `'standard'` (default), `'small'` or `'cleanAuxLarge'` |
| `weightsBaseUrl` | Directory containing the OIDN `.tza` files |
| `schedule` | `'converged'` (default), `'progressive'`, or `'every-sample'` |
| `maxTileSize` | Maximum OIDN tile size; chosen by oidn-web by default |
| `signal` | `AbortSignal` for the OIDN weight download; default undefined |
| `weightsUrl` | Explicit custom network; mutually exclusive with model/base directory |
| `aux`, `hdr`, `hdrTransfer` | Custom network metadata only; defaults true, true, `'pu'` |
| `auxiliaryModelUrls` | Both prefilter URLs; defaults to packaged cleanAuxLarge filters, otherwise none |
| `engine`, `precision`, `dynamicTile` | Defaults `'auto'`, `'auto'`, true; see custom networks below |

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
and WebGL 2; OIDN rejects JNLM fields.

## Custom OIDN networks

Load an explicit network file through the same built-in OIDN path:

```ts
final.denoiser = {
  type: 'oidn', weightsUrl: '/assets/custom.tza',
  aux: true, hdr: true, hdrTransfer: 'pu',
  engine: 'wgsl', precision: 'auto', dynamicTile: true
};
```

`weightsUrl` is mutually exclusive with `model` and `weightsBaseUrl`. The
custom network metadata defaults to `aux: true`, `hdr: true`,
`hdrTransfer: 'pu'`; those fields require `weightsUrl`. Explicit downloads
never fall back to a CDN. `auxiliaryModelUrls: {albedo, normal}` optionally
loads prefilters for either source; cleanAuxLarge supplies its packaged filters
by default. Override both auxiliary URLs together.

Execution settings are available for every OIDN configuration. `engine`
defaults to `'auto'`; `'wgsl'` selects native GPU inference and `'webnn'` the
experimental WebNN path. `precision` defaults to `'auto'` (FP16 when
shader-f16 is available), with `'fp32'` and `'fp16'` overrides. `dynamicTile`
defaults to `true`; use `false` for fixed tiles or an object with
`minTileSize` (256), `initialTileSize` (432), `targetTileTimeMs` (16) and
`adjustmentStep` (16). Tile sizes are clamped/aligned by oidn-web.

All implementation settings participate in the network cache key; `schedule`
and download `signal` do not. Renders with different signals share a pending
load; its initial request's signal controls that download. Loading failures
report an engine error and can be retried by disabling and reassigning the
configuration. Nested tile/URL settings are copied and frozen too.

`@meimu/mutracer/oidn` contains only weight constants and the
`resolveOIDNModelUrl` / `resolveOIDNAuxiliaryModelUrls` URL helpers. Loading
functions and network handles are internal; configure them through Render.
OIDN option types are exported from the main entry.

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
