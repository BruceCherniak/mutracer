import { describe, expect, it } from 'vitest';
import {
  envMapDistribution,
  environmentMapSourcesMatch
} from '../../src/renderer/envMapDistribution';

function valueAt(
  data: Float32Array,
  width: number,
  x: number,
  y: number,
  channel: number
) {
  return data[2 * (y * width + x) + channel];
}

describe('environment importance distribution', () => {
  it('covers the bilinear footprint around a sharp HDR texel', () => {
    const distribution = envMapDistribution({
      width: 3,
      height: 1,
      data: new Float32Array([
        0, 0, 0,
        100, 100, 100,
        0, 0, 0
      ])
    });
    const data = distribution.data as Float32Array;

    expect(valueAt(data, distribution.width, 0, 1, 0)).toBeCloseTo(1);
    for (let x = 1; x <= 3; x++) {
      expect(valueAt(data, distribution.width, x, 0, 1)).toBeGreaterThan(0);
    }
  });

  it('keeps an all-black environment distribution finite', () => {
    const distribution = envMapDistribution({
      width: 2,
      height: 2,
      data: new Float32Array(2 * 2 * 3)
    });

    expect(Array.from(distribution.data as Float32Array).every(Number.isFinite))
      .toBe(true);
  });

  it('reads RGBA texels without treating alpha as the next pixel', () => {
    const distribution = envMapDistribution({
      width: 2,
      height: 1,
      data: new Float32Array([
        0, 0, 0, 1,
        10, 10, 10, 1
      ])
    });
    const data = distribution.data as Float32Array;

    expect(Array.from(data).every(Number.isFinite)).toBe(true);
    expect(valueAt(data, distribution.width, 0, 1, 0)).toBeCloseTo(1);
  });

  it.each([[1, 1], [1, 5], [5, 1], [5, 4]])('preserves the clamped filter footprint and normalized PDFs for %i×%i maps', (width, height) => {
    // Vary radiance at every texel, including the seam and poles; alpha must
    // not affect the distribution. Compute expected weights from the footprint.
    const data = Float32Array.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 1000 : ((i * 17) % 31) / 4);
    const distribution = envMapDistribution({ width, height, data });
    const weights = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const neighbors: number[] = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const offset = 4 * (Math.max(0, Math.min(height - 1, y + dy)) * width + Math.max(0, Math.min(width - 1, x + dx)));
          neighbors.push(Math.fround(.2126 * data[offset] + .7152 * data[offset + 1] + .0722 * data[offset + 2]));
        }
        return Math.max(1e-12, ...neighbors) * Math.sin(Math.PI * (y + .5) / height);
      }));
    const rowIntegrals = weights.map(row => row.reduce((sum, weight) => sum + weight, 0) / width);
    const integral = rowIntegrals.reduce((sum, weight) => sum + weight, 0) / height;
    const cdf = distribution.data as Float32Array;
    for (let y = 0; y < height; y++) {
      expect(valueAt(cdf, distribution.width, 0, y, 1)).toBeCloseTo(rowIntegrals[y] / integral, 6);
      for (let x = 0; x < width; x++) {
        expect(valueAt(cdf, distribution.width, x + 1, y, 1)).toBeCloseTo(weights[y][x] / rowIntegrals[y], 6);
      }
      expect(valueAt(cdf, distribution.width, width + 1, y, 0)).toBeCloseTo(1, 6);
    }
    expect(valueAt(cdf, distribution.width, 0, height, 0)).toBeCloseTo(1, 6);
  });

  it('reuses distributions by source identity, dimensions, and version', () => {
    const data = new Float32Array([
      1, 1, 1, 1,
      0.25, 0.25, 0.25, 1
    ]);
    const cacheKey = {};
    const firstSource = {
      width: 2,
      height: 1,
      data,
      distributionCacheKey: cacheKey,
      distributionCacheVersion: 3
    };
    const sameSourceWrapper = {
      width: 2,
      height: 1,
      data: data.slice(),
      distributionCacheKey: cacheKey,
      distributionCacheVersion: 3
    };
    const changedVersionSource = {
      width: 2,
      height: 1,
      data,
      distributionCacheKey: cacheKey,
      distributionCacheVersion: 4
    };
    const changedDimensionsSource = {
      width: 1,
      height: 2,
      data,
      distributionCacheKey: cacheKey,
      distributionCacheVersion: 4
    };
    const first = envMapDistribution(firstSource);
    const sameSource = envMapDistribution(sameSourceWrapper);
    const changedVersion = envMapDistribution(changedVersionSource);
    const changedDimensions = envMapDistribution(changedDimensionsSource);

    expect(environmentMapSourcesMatch(firstSource, sameSourceWrapper)).toBe(true);
    expect(environmentMapSourcesMatch(firstSource, changedVersionSource)).toBe(false);
    expect(environmentMapSourcesMatch(changedVersionSource, changedDimensionsSource))
      .toBe(false);
    expect(sameSource).toBe(first);
    expect(changedVersion).not.toBe(first);
    expect(changedDimensions).not.toBe(changedVersion);
  });
});
