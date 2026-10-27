/**
 * Per-pixel auxiliary accumulation: the shadow-catcher mask, its premultiplied
 * primary background contribution (including opaque flat primary misses), and
 * luminance moments for the built-in denoiser's variance estimate.
 */
export const SHADOW_CATCHER_ACCUMULATION_BYTES = 48;

export default /* wgsl */ `
struct ShadowCatcherAccumulation {
  // Catcher coverage, separated background alpha, catcher background hits.
  mask: vec4f,
  background: vec4f,
  // Sum of the denoising guide value and of its square (x, y), and of the
  // catcher's occluded and total light sample counts (z, w).
  moments: vec4f,
}
`;
