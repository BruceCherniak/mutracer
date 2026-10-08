export interface OfflineVarianceHistory {
  width: number;
  height: number;
  tileSize: number;
  columns: number;
  rows: number;
  meanLuminance: Float32Array;
  variance: Float32Array;
  sampleTargets: Uint32Array;
}

export interface OfflineAdaptiveSamplingOptions {
  /** Independent pilot samples used only to estimate the final budget. */
  pilotSamples?: number;
  /** Smallest final sample count assigned to any pixel. */
  minSamples?: number;
  /** Largest final sample count assigned to any pixel. */
  maxSamples: number;
  /** Linear-HDR absolute standard-error target. */
  absoluteError?: number;
  /** Standard-error target relative to mean luminance. */
  relativeError?: number;
  /** Confidence multiplier. 1.96 corresponds to an approximate 95% interval. */
  confidence?: number;
  /** Spatial budget granularity. Pixels in a tile receive the same target. */
  tileSize?: number;
  /** Conservative variance history from the preceding animation frame. */
  previous?: OfflineVarianceHistory;
}

/** Compact plan metadata returned after GPU-side target generation. */
export interface OfflineAdaptiveSamplingResult {
  maximumTarget: number;
  averageTarget: number;
  history: OfflineVarianceHistory;
}

export interface NormalizedOfflineAdaptiveSamplingOptions {
  maxSamples: number;
  minSamples: number;
  tileSize: number;
  columns: number;
  rows: number;
  absoluteError: number;
  relativeError: number;
  confidence: number;
  previous?: OfflineVarianceHistory;
}


function normalizedInteger(value: number | undefined, fallback: number) {
  return Number.isFinite(value)
    ? Math.max(1, Math.round(value!))
    : fallback;
}

function compatibleHistory(
  history: OfflineVarianceHistory | undefined,
  width: number,
  height: number,
  tileSize: number,
  columns: number,
  rows: number
) {
  return !!history &&
    history.width === width &&
    history.height === height &&
    history.tileSize === tileSize &&
    history.columns === columns &&
    history.rows === rows &&
    history.variance.length === columns * rows;
}

/** Shared normalization keeps CPU fallback and GPU planning bit-for-bit aligned. */
export function normalizeOfflineAdaptiveSamplingOptions(
  options: OfflineAdaptiveSamplingOptions,
  width: number,
  height: number
): NormalizedOfflineAdaptiveSamplingOptions {
  const maxSamples = normalizedInteger(options.maxSamples, 1);
  const minSamples = Math.min(
    maxSamples,
    normalizedInteger(options.minSamples, Math.min(maxSamples, 16))
  );
  const tileSize = normalizedInteger(options.tileSize, 16);
  const columns = Math.ceil(width / tileSize);
  const rows = Math.ceil(height / tileSize);
  return {
    maxSamples,
    minSamples,
    tileSize,
    columns,
    rows,
    absoluteError: Math.max(options.absoluteError ?? 0.002, 1e-8),
    relativeError: Math.max(options.relativeError ?? 0.03, 0),
    confidence: Math.max(options.confidence ?? 1.96, 0.01),
    previous: compatibleHistory(
      options.previous,
      width,
      height,
      tileSize,
      columns,
      rows
    )
      ? options.previous
      : undefined
  };
}

