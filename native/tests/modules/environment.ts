/// <reference path="../../src/browser-types.d.ts" />
import { envMapDistribution, environmentMapSourcesMatch, type EnvironmentMapSource } from '../../../src/renderer/envMapDistribution.js';
import { pixelLength, pixelValue, writePixel } from '../../../src/scene/texturePixels.js';
import type { TextureDataSource } from '../../../src/scene/Texture.js';

export function environmentParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 5);
  const width = input[0], height = input[1], storage = input[2], channels = input[3], flags = input[4];
  const length = width * height * channels;
  let data: TextureDataSource['data'];
  if (storage === 0) data = new Float32Array(length);
  else if (storage === 1) data = new Int32Array(length);
  else if (storage === 2) data = new Uint8Array(length);
  else data = new Uint8ClampedArray(length);
  for (let i = 0; i < length; i++) {
    const value = flags & 1 ? 0 : flags & 2 ? (i === 0 ? 255 : 0) : (i * 37 + 11) % 256;
    writePixel(data, i, storage === 0 ? value * .125 : value);
  }
  const key = { token: 1 };
  const image: EnvironmentMapSource = { data, width, height,
    distributionCacheKey: flags & 4 ? key : undefined, distributionCacheVersion: 0 };
  const first = envMapDistribution(image), cached = envMapDistribution(image);
  const duplicate: EnvironmentMapSource = { data, width, height,
    distributionCacheKey: image.distributionCacheKey, distributionCacheVersion: 0 };
  const matches = environmentMapSourcesMatch(image, duplicate);
  duplicate.distributionCacheVersion = 1;
  const differs = environmentMapSourcesMatch(image, duplicate);
  const firstData = new Float32Array(pixelLength(first.data));
  for (let i = 0; i < firstData.length; i++) firstData[i] = pixelValue(first.data, i);
  writePixel(data, 0, 1);
  image.distributionCacheVersion = 1;
  const updated = envMapDistribution(image);
  const result = new Float32Array(8 + firstData.length + pixelLength(updated.data));
  result.set([first.width, first.height, first === cached ? 1 : 0,
    matches ? 1 : 0, differs ? 1 : 0, first === updated ? 1 : 0, firstData.length, pixelLength(updated.data)]);
  result.set(firstData, 8);
  for (let i = 0; i < pixelLength(updated.data); i++) result[8 + firstData.length + i] = pixelValue(updated.data, i);
  return new Uint8Array(result.buffer);
}
