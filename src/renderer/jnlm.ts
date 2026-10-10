/**
 * Joint non-local means (JNLM) denoiser, after Rousselle, Manzi and Zwicker,
 * "Robust Denoising using Feature and Color Information" (Pacific Graphics
 * 2013). Each pixel is a weighted mean of its neighborhood. The weight of a
 * neighbor is the minimum of
 *
 * - a color weight: the NL-means distance between the two pixels' patches,
 *   normalized by their estimated variance, so differences explained by
 *   noise are ignored and real structure is kept;
 * - a feature weight: the albedo, coverage and normal differences, which keep
 *   texture and geometric edges that the noisy color cannot resolve.
 *
 * Weights are computed on a per-sample luminance guide whose moments are
 * accumulated by the ray tracer, and applied to the complete composed image.
 * The WebGPU (WGPUJNLMDenoiser) and WebGL 2 (WebGLJNLMDenoiser) passes
 * implement the same filter with these parameters.
 */

/** Neighborhood radius in pixels; the search window is 11 x 11. */
export const JNLM_SEARCH_RADIUS = 5;
/** Patch radius in pixels; patches are 5 x 5. */
export const JNLM_PATCH_RADIUS = 2;
/** Filter passes; the second samples every other pixel. */
export const JNLM_ITERATIONS = 2;
/** Color sensitivity k_c of the paper. Larger values filter more. */
export const JNLM_DEFAULT_COLOR_SENSITIVITY = 0.6;
/** Feature bandwidths: albedo (and coverage), and normals encoded as n * 0.5 + 0.5. */
export const JNLM_ALBEDO_BANDWIDTH = 0.1;
export const JNLM_NORMAL_BANDWIDTH = 0.2;

/** Filter shape; fixed by default, adjustable for evaluation. */
export interface JNLMFilterShape {
  searchRadius: number;
  patchRadius: number;
  albedoBandwidth: number;
  normalBandwidth: number;
  /**
   * Filter passes. Each pass filters the previous result with double the
   * sample spacing (a-trous), which removes the blotches a single NL-means
   * pass leaves at the scale of its window.
   */
  iterations: number;
}

export const JNLM_DEFAULT_SHAPE: JNLMFilterShape = {
  searchRadius: JNLM_SEARCH_RADIUS,
  patchRadius: JNLM_PATCH_RADIUS,
  albedoBandwidth: JNLM_ALBEDO_BANDWIDTH,
  normalBandwidth: JNLM_NORMAL_BANDWIDTH,
  iterations: JNLM_ITERATIONS
};

/** The built-in denoiser as attached to the pipeline. */
export interface JNLMDenoiser {
  readonly type: 'jnlm';
  /** Filter strength multiplier, applied to the color sensitivity. */
  strength: number;
  shape: JNLMFilterShape;
  dispose(): void;
}

export function createJNLMDenoiser(strength = 1): JNLMDenoiser {
  return { type: 'jnlm', strength, shape: { ...JNLM_DEFAULT_SHAPE }, dispose() {} };
}

export function isJNLMDenoiser(denoiser: unknown): denoiser is JNLMDenoiser {
  return (denoiser as JNLMDenoiser | undefined)?.type === 'jnlm';
}

/** Pixel spacing of filter pass `index` (from 0): 1, 2, 4, ... */
export function jnlmPassDilation(index: number) {
  return 2 ** index;
}
