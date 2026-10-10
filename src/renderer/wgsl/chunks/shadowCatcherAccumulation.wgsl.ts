/**
 * Per-pixel auxiliary accumulation: the shadow-catcher mask, its premultiplied
 * primary background contribution, and luminance moments for the built-in
 * denoiser's variance estimate.
 */
export const SHADOW_CATCHER_ACCUMULATION_BYTES = 48;

export default /* wgsl */ `
struct ShadowCatcherAccumulation {
  // Primary catcher coverage, background alpha, background hits, shadow opacity.
  mask: vec4f,
  background: vec4f,
  // Sum of the denoising guide value and of its square (x, y).
  moments: vec4f,
}
`;
