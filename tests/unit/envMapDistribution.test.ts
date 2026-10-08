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
