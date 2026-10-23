import type { ProceduralSkyImage } from '../scene/skyParameters.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

// Create a piecewise 2D cumulative distribution function of light intensity from an env map
// http://www.pbr-book.org/3ed-2018/Monte_Carlo_Integration/2D_Sampling_with_Multidimensional_Transformations.html#Piecewise-Constant2DDistributions

import type { TextureDataSource } from '../scene/textureData.js';
import { pixelLength, pixelValue } from '../scene/texturePixels.js';

export interface EnvironmentMapSource extends TextureDataSource {
  /** Stable identity shared by adapters that recreate source wrappers. */
  distributionCacheKey?: object;
  /** Incremented whenever the source pixels change in place. */
  distributionCacheVersion?: number;
}

/** GPU-generated radiance, including the scene's linear intensity and ambient fill. */
export interface ProceduralEnvironmentSource {
  sky: ProceduralSkyImage;
  width: number;
  height: number;
  intensity: number;
  ambient: [number, number, number];
}
export type EnvironmentSource = EnvironmentMapSource | ProceduralEnvironmentSource;

interface DistributionCacheEntry {
  width: number;
  height: number;
  version: number;
  distribution: TextureDataSource;
}

const distributionCache = new WeakMap<object, DistributionCacheEntry>();

function distributionCacheIdentity(image: EnvironmentSource) {
  return 'sky' in image ? image : image.distributionCacheKey ?? image.data;
}

export function environmentMapSourcesMatch(
  first: EnvironmentSource | undefined,
  second: EnvironmentSource | undefined
) {
  if (first === second) return true;
  if (!first || !second) return false;
  return (
    distributionCacheIdentity(first) === distributionCacheIdentity(second) &&
    first.width === second.width &&
    first.height === second.height &&
    ('sky' in first ? 0 : first.distributionCacheVersion ?? 0) ===
      ('sky' in second ? 0 : second.distributionCacheVersion ?? 0)
  );
}

export function envMapDistribution(
  image: EnvironmentMapSource
): TextureDataSource {
  const cacheKey = distributionCacheIdentity(image);
  const version = image.distributionCacheVersion ?? 0;
  const cached = distributionCache.get(cacheKey);
  if (
    cached &&
    cached.width === image.width &&
    cached.height === image.height &&
    cached.version === version
  ) {
    return cached.distribution;
  }
  const data = image.data;

  const width = image.width + 2, height = image.height + 1;
  const cdf = makeTextureArray(width, height, 2);
  const cdfImage: TextureDataSource = { width, height, data: cdf.array };

  const luminance = environmentLuminance(data, image.width, image.height);

  // Environment radiance is read with bilinear filtering while the CDF is
  // piecewise constant. Dilating luminance over the filter footprint keeps a
  // sharp HDR sun from leaking into a neighbouring low-PDF cell and producing
  // fireflies. This only changes the importance distribution, not the
  // radiance integral, so the estimator remains unbiased.
  // A separable max filter has the same clamped 3×3 footprint, with three
  // reads per pass instead of nine clamped reads for every output texel.
  const horizontal = new Float32Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) {
    const row = y * image.width;
    for (let x = 0; x < image.width; x++) {
      horizontal[row + x] = Math.max(0,
        luminance[row + Math.max(0, x - 1)], luminance[row + x],
        luminance[row + Math.min(image.width - 1, x + 1)]);
    }
  }

  for (let y = 0; y < image.height; y++) {
    const sinTheta = Math.sin((Math.PI * (y + 0.5)) / image.height);
    const above = Math.max(0, y - 1) * image.width;
    const row = y * image.width;
    const below = Math.min(image.height - 1, y + 1) * image.width;
    for (let x = 0; x < image.width; x++) {
      const weight = Math.max(horizontal[above + x], horizontal[row + x], horizontal[below + x], 1e-12) * sinTheta;
      cdf.set(x + 2, y, 0, cdf.get(x + 1, y, 0) + weight / image.width);
      cdf.set(x + 1, y, 1, weight);
    }

    const rowIntegral = cdf.get(cdfImage.width - 1, y, 0);

    for (let x = 1; x < cdf.width; x++) {
      cdf.set(x, y, 0, cdf.get(x, y, 0) / rowIntegral);
      cdf.set(x, y, 1, cdf.get(x, y, 1) / rowIntegral);
    }

    cdf.set(0, y + 1, 0, cdf.get(0, y, 0) + rowIntegral / image.height);
    cdf.set(0, y, 1, rowIntegral);
  }

  const integral = cdf.get(0, cdf.height - 1, 0);

  for (let y = 0; y < cdf.height; y++) {
    cdf.set(0, y, 0, cdf.get(0, y, 0) / integral);
    cdf.set(0, y, 1, cdf.get(0, y, 1) / integral);
  }
  cdfImage.data = cdf.array;

  distributionCache.set(cacheKey, {
    width: image.width,
    height: image.height,
    version,
    distribution: cdfImage
  });

  return cdfImage;
}

function makeTextureArray(width: number, height: number, channels: number) {
  const array = new Float32Array(channels * width * height);

  return {
    set(x: number, y: number, channel: number, val: number) {
      array[channels * (y * width + x) + channel] = val;
    },
    get(x: number, y: number, channel: number) {
      return array[channels * (y * width + x) + channel];
    },
    width,
    height,
    channels,
    array
  };
}

function environmentLuminance(data: TextureDataSource['data'], width: number, height: number): Float32Array {
  if (data instanceof Uint8Array) return environmentLuminanceKernel(data, width, height, 1 / 255);
  if (data instanceof Uint8ClampedArray) return environmentLuminanceKernel(data, width, height, 1 / 255);
  if (data instanceof Float32Array) return environmentLuminanceKernel(data, width, height, 1);
  return environmentLuminanceKernel(data, width, height, 1);
}

function environmentLuminanceKernel<T extends TextureDataSource['data']>(data: T, width: number, height: number, sourceScale: number): Float32Array {
  const channels = Math.max(
    Math.floor(pixelLength(data) / (width * height)),
    1
  );
  const luminance = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sourceIndex = channels * (y * width + x);
      luminance[y * width + x] =
        sourceScale * (
          0.2126 * pixelValue(data, sourceIndex)
          + 0.7152 * pixelValue(data, sourceIndex + Math.min(1, channels - 1))
          + 0.0722 * pixelValue(data, sourceIndex + Math.min(2, channels - 1))
        );
    }
  }

  return luminance;
}
