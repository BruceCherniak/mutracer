# Denoising (Intel Open Image Denoise)

MuTracer runs [Intel Open Image Denoise](https://www.openimagedenoise.org/)
networks on the renderer's WebGPU device through
[`oidn-web`](https://www.npmjs.com/package/oidn-web). The denoiser uses the
accumulated color plus albedo and normal guides, so it works well from a few
dozen samples. WebGL 2 is not supported.

```ts
const renderer = new Renderer({ canvas });
await renderer.setDenoiser();                     // standard model
await renderer.setDenoiser({ model: 'small' });   // replace it
await renderer.setDenoiser(false);                // remove it
```

or `new Renderer({ canvas, denoiser: true })`.

With a denoiser attached, when `maxSamples` is reached `render()` returns
`RENDER_STATUS_DENOISING` and then `RENDER_STATUS_FINISHED` with the denoised
image. `renderOfflineFrame` denoises before resolving. A lower `maxSamples`
(e.g. 64–256) is usually enough.

`setDenoiser()` rejects on WebGL or when the weights fail to load. The OIDN code
is loaded with a dynamic import, so it costs nothing until used.

## Models

| `model` | Weights | Use |
| --- | --- | --- |
| `'standard'` (default) | `rt_hdr_alb_nrm.tza` (1.8 MB) | Balanced quality and speed; bundled with mutracer |
| `'small'` | `rt_hdr_alb_nrm_small.tza` (0.6 MB) | Fastest; previews while converging; bundled with mutracer |
| `'cleanAuxLarge'` | `rt_hdr_calb_cnrm_large.tza` + `rt_alb_large.tza` + `rt_nrm_large.tza` (22 MB) | Highest quality; prefilters guides; from oidn-weights@2.3.0 |

## Hosting the weights

Standard and small load from your application's own build assets by default.
Vite and webpack 5 copy the package's static weight URLs into the output.
In Vite development add `optimizeDeps: { exclude: ['mutracer'] }` to avoid
prebundling asset URLs; otherwise MuTracer warns once and falls back to
jsDelivr's copy for the installed MuTracer version. The standalone `dist/`
library bundles use that CDN copy directly.

The large beauty network and auxiliary prefilters default to
`https://cdn.jsdelivr.net/npm/oidn-weights@2.3.0/`. To self-host all networks,
install `oidn-weights@2.3.0` and copy `node_modules/oidn-weights/*.tza` to a
static directory. If you only use standard/small, copying the two files from
`node_modules/mutracer/oidn/weights/` is sufficient:

```ts
await renderer.setDenoiser({ weightsBaseUrl: '/assets/oidn/weights/' });
```

Explicit URLs never fall back to the CDN. Every download is checked for the
TZA file signature. The weights use Apache-2.0 (`oidn/weights/LICENSE.txt`).

## Denoising while converging

```ts
await renderer.setDenoiser({ whileConverging: true });
```

With `whileConverging` the interactive preview is denoised while the camera
moves, with the `previewModel` network (`small` by default) at a resolution
lowered until the denoiser keeps up. A camera change cancels a settled denoise
that is still running. The accumulating image is re-denoised every
`sampleInterval` samples (default 8). Pass `coalesceSceneUpdates: true` for
animation playback, which coalesces continuous scene changes into the latest
frame.

## Options

| `DenoiserOptions` | Description |
| --- | --- |
| `model` | `'standard'`, `'small'` or `'cleanAuxLarge'` |
| `previewModel` | Network for while-converging preview frames, or `false` to use `model`. Default `'small'` |
| `weightsBaseUrl` | Directory containing the `.tza` files |
| `whileConverging` | Denoise previews and intermediate frames, not only the final image. Default `false` |
| `sampleInterval` | Samples between denoised updates with `whileConverging`. Default `8` |
| `coalesceSceneUpdates` | With `whileConverging`, render the latest scene state after a denoise instead of restarting on every scene change. Default `false` |
| `maxTileSize` | Maximum tile size; chosen by oidn-web by default |
| `signal` | `AbortSignal` for the download |

`mutracer/oidn` exposes `initializeOIDN(renderer, options)` and
`initializeOIDNFromURL(renderer, url, options)` for custom weights; they
attach the result to `renderer.oidn`, which denoises with the mode last set by
`setDenoiser()` (the final image only by default).
