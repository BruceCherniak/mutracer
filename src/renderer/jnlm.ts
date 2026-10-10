/**
 * Joint non-local means (JNLM) denoiser, after Rousselle, Manzi and Zwicker,
 * "Robust Denoising using Feature and Color Information" (Pacific Graphics
 * 2013). Each pixel starts with a weighted mean of its neighborhood. The
 * weight of a neighbor is the minimum of
 *
 * - a color weight: the NL-means distance between the two pixels' patches,
 *   normalized by their estimated variance, so differences explained by
 *   noise are ignored and real structure is kept;
 * - a feature weight: the albedo, coverage and normal differences, which keep
 *   texture and geometric edges that the noisy color cannot resolve.
 *
 * A bounded, regularized local albedo regression corrects that mean to retain
 * low-contrast texture while averaging lighting noise. Each RGB channel is
 * fitted independently using the same JNLM weights.
 *
 * Weights are computed on a per-sample luminance guide whose moments are
 * accumulated by the ray tracer, and applied to the complete composed image.
 * The WebGPU (WGPUJNLMDenoiser) and WebGL 2 (WebGLJNLMDenoiser) passes
 * implement the same filter with these parameters.
 */

/** Neighborhood radius in pixels; the search window is 11 x 11. */
export const JNLM_SEARCH_RADIUS = 5;
/** Patch radius in pixels; patches are 3 x 3 to retain small color details. */
export const JNLM_PATCH_RADIUS = 1;
/** Filter passes; the second samples every other pixel. */
export const JNLM_ITERATIONS = 2;
/** Color sensitivity k_c of the paper. Larger values filter more. */
export const JNLM_DEFAULT_COLOR_SENSITIVITY = 0.6;
/** Relative RGB albedo bandwidth. */
export const JNLM_ALBEDO_BANDWIDTH = 0.4;
/** Absolute coverage bandwidth, independent of albedo brightness. */
export const JNLM_COVERAGE_BANDWIDTH = 0.1;
/** Minimum linear albedo used to normalize contrast near black. */
export const JNLM_ALBEDO_FLOOR = 0.02;
/** Squared relative contrast ridge for the local albedo regression (1%). */
export const JNLM_ALBEDO_REGULARIZATION = 0.0001;
/** Normal bandwidth, with normals encoded as n * 0.5 + 0.5. */
export const JNLM_NORMAL_BANDWIDTH = 0.05;
/** Maximum number of filter passes supported by both backends. */
export const JNLM_MAX_ITERATIONS = 4;

/** User-configurable options for the built-in JNLM denoiser. */
export interface JNLMOptions {
  /** Positive filter strength multiplier; larger values smooth more. Default `1`. */
  strength?: number;
  /** Search radius in pixels, an integer from `1` to `16`. Default `5` (11 × 11). */
  searchRadius?: number;
  /** Color comparison patch radius, an integer from `0` to `3`. Default `1` (3 × 3). */
  patchRadius?: number;
  /** Relative RGB albedo tolerance, from `0.0001` to `10`. Larger values mix more texture. Default `0.4`. */
  albedoBandwidth?: number;
  /** Encoded normal tolerance, from `0.0001` to `10`. Larger values mix more geometric detail. Default `0.05`. */
  normalBandwidth?: number;
  /** Filter passes, an integer from `1` to `4`; each doubles the spacing. Default `2`. */
  iterations?: number;
}

/** Default JNLM settings used when options are omitted. */
export const DEFAULT_JNLM_OPTIONS: Readonly<Required<JNLMOptions>> = Object.freeze({
  strength: 1,
  searchRadius: JNLM_SEARCH_RADIUS,
  patchRadius: JNLM_PATCH_RADIUS,
  albedoBandwidth: JNLM_ALBEDO_BANDWIDTH,
  normalBandwidth: JNLM_NORMAL_BANDWIDTH,
  iterations: JNLM_ITERATIONS
});

/** Filter shape; fixed by default, adjustable for evaluation. */
export interface JNLMFilterShape {
  searchRadius: number;
  patchRadius: number;
  /** Relative RGB contrast. */
  albedoBandwidth: number;
  /** Absolute difference of normals encoded as n * 0.5 + 0.5. */
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

export function createJNLMDenoiser(options: JNLMOptions = {}): JNLMDenoiser {
  const values = { ...DEFAULT_JNLM_OPTIONS };
  for (const key of Object.keys(values) as (keyof JNLMOptions)[]) {
    const value = options[key];
    if (value !== undefined) values[key] = value;
  }
  if (!Number.isFinite(values.strength) || values.strength <= 0) {
    throw new Error('strength must be finite and positive');
  }
  for (const [key, min, max] of [
    ['searchRadius', 1, 16], ['patchRadius', 0, 3], ['iterations', 1, JNLM_MAX_ITERATIONS]
  ] as const) {
    if (!Number.isInteger(values[key]) || values[key] < min || values[key] > max) {
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    }
  }
  for (const key of ['albedoBandwidth', 'normalBandwidth'] as const) {
    if (!Number.isFinite(values[key]) || values[key] < 0.0001 || values[key] > 10) {
      throw new Error(`${key} must be finite and from 0.0001 to 10`);
    }
  }
  const { strength, ...shape } = values;
  return { type: 'jnlm', strength, shape, dispose() {} };
}

export function isJNLMDenoiser(denoiser: unknown): denoiser is JNLMDenoiser {
  return (denoiser as JNLMDenoiser | undefined)?.type === 'jnlm';
}

/** Pixel spacing of filter pass `index` (from 0): 1, 2, 4, ... */
export function jnlmPassDilation(index: number) {
  return 2 ** index;
}
