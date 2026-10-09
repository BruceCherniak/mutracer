# Sampling patterns

`renderer.samplingPattern` selects the sequence independently of OIDN.
Changing it restarts accumulation. The choices are:

- `sobol` (default): Burley Owen-scrambled 2D Sobol sequences, independently
  scrambled per pixel and domain. It converges within each pixel and produces
  spatially decorrelated error suited to OIDN.
- `zsobol`: opt-in Morton-ordered Sobol sampling for spatial blue-noise error,
  especially useful at low sample counts without a denoiser.
- `random`: PCG white noise, useful as an independent Monte Carlo reference.

ZSobol uses **blue-noise-first**: sample zero uses a one-sample ZSobol
pattern, and later samples use an independent scramble for the remaining
budget. This preserves blue-noise error in the first preview even when
`maxSamples` is large. The remaining budget is rounded up to a power of two,
capped at 65536 samples; unlimited rendering uses that cap. Early prefixes
still cannot all have exact blue-noise properties. Changing the rounded budget
restarts accumulation. Independent 256×256 pixel tiles and sample blocks
keep Morton indices within 32 bits. The structured patterns use per-pixel
Owen Sobol for variable-count traversal. `random` keeps PCG for these choices.

Offline sequences are deterministic, including `sampleSequenceOffset`.
Each WebGPU pixel advances using its own accumulated count, so adaptive
sampling and interleaved preview tiles cannot skip sequence points. Camera
jitter and aperture use separate 2D domains; light positions, BSDF directions
and phase directions likewise have their own pairs. Variable-length alpha,
displacement and traversal choices use a separate hashed dimension range.
Spectral wavelengths reuse dimensions and random streams to reduce colored
noise. Interactive resets retain seed zero for stable screen-relative noise.

The backends can differ in floating-point rounding during conversion and
shading even with identical integer sequence points. Finite-width, very narrow
specular lobes under directional lights can produce rare, large Monte Carlo
contributions with any pattern; sampling does not clamp these contributions.

The former `useStratifiedSampling` option and the CPU stratified sampler have
been removed. Select `samplingPattern` explicitly when migrating; the default
is `sobol`. ZSobol generates its blue-noise pattern without a texture asset.
