export const DEFAULT_BEVEL_SAMPLES = 8;
export const MIN_BEVEL_SAMPLES = 1;
export const MAX_BEVEL_SAMPLES = 32;

/** Light candidates resampled per NEE estimate by the WebGPU path tracer. */
export const DEFAULT_DIRECT_LIGHT_CANDIDATES = 4;
export const MIN_DIRECT_LIGHT_CANDIDATES = 1;
export const MAX_DIRECT_LIGHT_CANDIDATES = 16;

export function normalizeDirectLightCandidates(candidates: number) {
  if (!Number.isFinite(candidates)) return DEFAULT_DIRECT_LIGHT_CANDIDATES;
  return Math.min(
    MAX_DIRECT_LIGHT_CANDIDATES,
    Math.max(MIN_DIRECT_LIGHT_CANDIDATES, Math.round(candidates))
  );
}

export function normalizeBevelSamples(samples: number) {
  if (!Number.isFinite(samples)) return DEFAULT_BEVEL_SAMPLES;
  return Math.min(
    MAX_BEVEL_SAMPLES,
    Math.max(MIN_BEVEL_SAMPLES, Math.round(samples))
  );
}
