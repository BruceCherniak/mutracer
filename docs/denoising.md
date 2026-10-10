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
| `'standard'` (default) | `rt_hdr_alb_nrm.tza` (1.8 MB) | Balanced quality and speed |
| `'small'` | `rt_hdr_alb_nrm_small.tza` (0.6 MB) | Fastest; previews while converging |
| `'cleanAuxLarge'` | `rt_hdr_calb_cnrm_large.tza` + `rt_alb_large.tza` + `rt_nrm_large.tza` (22 MB) | Highest quality; prefilters the albedo/normal guides |

## Hosting the weights

By default the weights are downloaded from jsDelivr, pinned to the installed
MuTracer version:

```
https://cdn.jsdelivr.net/npm/mutracer@<version>/oidn/weights/
```

For production, serve them yourself. They ship in the npm package at
`node_modules/mutracer/oidn/weights/`; copy that folder to your static assets
and pass its URL:

```ts
await renderer.setDenoiser({ weightsBaseUrl: '/assets/oidn/weights/' });
```

The weights are licensed under Apache-2.0 (`oidn/weights/LICENSE.txt`).

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
