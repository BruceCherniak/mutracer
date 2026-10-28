/// <reference path="../src/browser-types.d.ts" />
import {writeRawAtlasPlacement} from '../../src/renderer/textureAtlasPixels.js';
import {envMapDistribution} from '../../src/renderer/envMapDistribution.js';
import {estimateEnvironmentPower} from '../../src/renderer/lightSampling.js';
import type {TextureDataSource} from '../../src/scene/textureData.js';

function pixels(mode: number, values: Float64Array): TextureDataSource['data'] {
  if (mode === 0) {const out = new Uint8Array(values.length + 2); for (let i = 0; i < values.length; i++) out[i + 1] = values[i]; return out.subarray(1, values.length + 1);}
  if (mode === 1) {const out = new Uint8ClampedArray(values.length + 2); for (let i = 0; i < values.length; i++) out[i + 1] = values[i]; return out.subarray(1, values.length + 1);}
  if (mode === 2) {const out = new Float32Array(values.length + 2); for (let i = 0; i < values.length; i++) out[i + 1] = values[i]; return out.subarray(1, values.length + 1);}
  const out = new Int32Array(values.length + 2); for (let i = 0; i < values.length; i++) out[i + 1] = values[i]; return out.subarray(1, values.length + 1);
}
// Executed through the production compiler lowering and a C consumer. Its
// oracle imports the unmodified Web TS functions, not the generated kernels.
export function storageParameters(bytes: Uint8Array): Uint8Array {
  const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 8);
  const values = new Float64Array(bytes.buffer, bytes.byteOffset + 32, (bytes.byteLength - 32) / 8);
  const source = pixels(u[0], values), width = u[6] + 3, height = u[7] + 2;
  const data = u[1] ? new Uint16Array(width * height * 4).fill(17) : new Uint8Array(width * height * 4).fill(17);
  writeRawAtlasPlacement(data, width, {x: 1, y: 1, width: u[6], height: u[7], index: 0, layer: 0},
    {image: {width: u[4], height: u[5], data: source}, flipY: !!u[3]}, !!u[2]);
  const atlas = data instanceof Uint16Array ? new Uint8Array(data.buffer) : new Uint8Array(data.buffer);
  const image = {width: u[4], height: u[5], data: source};
  const distribution = envMapDistribution(image);
  if (!(distribution.data instanceof Float32Array)) throw new Error('Expected float CDF');
  const cdf = new Uint8Array(distribution.data.buffer);
  const power = new Float64Array([estimateEnvironmentPower(image)]);
  const result = new Uint8Array(16 + atlas.byteLength + cdf.byteLength + 8);
  const header = new Uint32Array(result.buffer, 0, 4);
  header[0] = atlas.byteLength; header[1] = cdf.byteLength;
  result.set(atlas, 16); result.set(cdf, 16 + atlas.byteLength);
  result.set(new Uint8Array(power.buffer), 16 + atlas.byteLength + cdf.byteLength);
  return result;
}
