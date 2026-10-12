# Sampling patterns

`render.samplingPattern` selects the sample sequence. Changing it restarts
accumulation. The denoiser never changes it.

| Pattern | Use |
| --- | --- |
| `'sobol'` (default) | General use, and with any denoiser. Owen-scrambled Sobol; converges well per pixel with spatially decorrelated error |
| `'zsobol'` | Low sample counts **without** a denoiser. Morton-ordered Sobol with blue-noise error |
| `'random'` | PCG white noise; an independent Monte Carlo reference |

```ts
render.samplingPattern = 'zsobol';
```

## Caveats

- **ZSobol budget**: ZSobol sizes its pattern from `maxSamples`, rounded up to
  a power of two and capped at 65536 (unlimited rendering uses the cap).
  Changing the rounded budget restarts accumulation. The first sample always
  has blue-noise error; later prefixes of a large budget cannot all keep it.
- **Determinism**: offline sequences are deterministic, including
  `sampleSequenceOffset`. Use disjoint offset ranges for animation frames.
- **Backends**: WebGPU and WebGL 2 can differ in floating-point rounding even
  with identical sequence points.
- **Fireflies**: very narrow specular lobes under directional lights can
  produce rare, large contributions with any pattern. Sampling does not clamp
  them; use `render.clamping` if needed.

## Implementation notes

- `sobol` uses Burley's Owen-scrambled 2D Sobol sequences, scrambled
  independently per pixel and domain.
- ZSobol is blue-noise-first: sample zero uses a one-sample ZSobol pattern,
  and later samples use an independent scramble for the remaining budget.
  Independent 256×256 pixel tiles and sample blocks keep Morton indices within
  32 bits. The pattern is generated without a texture asset.
- Each WebGPU pixel advances by its own accumulated count, so adaptive
  sampling and interleaved preview tiles cannot skip sequence points.
- Camera jitter, aperture, light positions, BSDF directions and phase
  directions each use their own 2D domain. Variable-length choices (alpha,
  displacement, traversal) use a separate hashed dimension range: per-pixel
  Owen Sobol for the structured patterns, PCG for `random`.
- Spectral wavelengths reuse dimensions and random streams to reduce colored
  noise. Interactive resets keep seed zero for stable screen-relative noise.
