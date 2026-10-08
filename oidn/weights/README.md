# Intel® Open Image Denoise weights

Trained weights of the convolutional networks used by
[Intel Open Image Denoise](https://github.com/OpenImageDenoise/oidn) (OIDN),
stored in OIDN's `.tza` format and released under the Apache License 2.0
(see [`LICENSE.txt`](./LICENSE.txt)).

| File | Used by |
| --- | --- |
| `rt_hdr_alb_nrm.tza` | `model: 'standard'` (default): HDR color + albedo + normal |
| `rt_hdr_alb_nrm_small.tza` | `model: 'small'`: fastest, for realtime denoising |
| `rt_hdr_calb_cnrm_large.tza` | `model: 'cleanAuxLarge'`: highest quality, with prefiltered guides |
| `rt_alb_large.tza`, `rt_nrm_large.tza` | Albedo / normal prefilters for `cleanAuxLarge` |

The large auxiliary weights come from
[RenderKit/oidn-weights](https://github.com/RenderKit/oidn-weights) at commit
[`28883d1769d5930e13cf7f1676dd852bd81ed9e7`](https://github.com/RenderKit/oidn-weights/tree/28883d1769d5930e13cf7f1676dd852bd81ed9e7)
(OIDN v2.3):

- `rt_alb_large.tza`: SHA-256 `a8efbe6eed511f41c8f5ff9145923214cefb0703cf91a3b00a1dc131ade1600a`
- `rt_nrm_large.tza`: SHA-256 `8ac7705ec5ac303116b40ad2f0880cd741ed1f4280828bf2f18f7635c3377257`

## Loading

`renderer.setDenoiser()` downloads these files from the jsDelivr copy of the
installed `claypt` version. For production, serve this directory yourself and
pass its URL:

```ts
await renderer.setDenoiser({
  model: 'standard',
  weightsBaseUrl: '/assets/oidn/weights/'
});
```

With npm, the files are at `node_modules/claypt/oidn/weights/`; copy them into
your static assets as part of the build.
