/** A square depth sampling area in viewport coordinates. */
export interface DepthSampleArea {
  /** Horizontal center, 0..1 from the left. Required. */
  x: number;
  /** Vertical center, 0..1 from the top. Required. */
  y: number;
  /** Half height as a fraction of viewport height; 0 samples one point. Required. */
  size: number;
}

export const DEPTH_SAMPLE_GRID = 7;
export const DEPTH_SAMPLE_COUNT = DEPTH_SAMPLE_GRID ** 2;

/** Bottom-left UV center and half extent, matching both camera-ray shaders. */
export function packDepthSampleArea(area: DepthSampleArea, aspect: number) {
  if (![area.x, area.y, area.size, aspect].every(Number.isFinite) ||
    area.x < 0 || area.x > 1 || area.y < 0 || area.y > 1 || area.size < 0 || aspect <= 0) {
    throw new RangeError('Depth sampling requires a viewport center in 0..1, a non-negative size and a positive aspect.');
  }
  return new Float32Array([area.x, 1 - area.y, area.size / aspect, area.size]);
}

export function unpackDepthSamples(rgba: Float32Array) {
  return Float32Array.from({ length: DEPTH_SAMPLE_COUNT }, (_, i) => rgba[i * 4]);
}
