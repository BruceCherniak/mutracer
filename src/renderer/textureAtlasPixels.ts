import type { TextureDataSource } from '../scene/textureData.js';
import { pixelLength, pixelValue } from '../scene/texturePixels.js';
import type { AtlasPlacement } from './textureAtlas.js';
import { float16Bits } from './float16.js';

export function writeAtlasPixel(data: Uint16Array | Uint8Array, index: number, value: number) {
  if (data instanceof Uint16Array) data[index] = value;
  else data[index] = value;
}
export function writeRawAtlasPlacement(data: Uint16Array | Uint8Array, width: number,
  placement: AtlasPlacement, texture: {image: TextureDataSource; flipY: boolean}, floatStorage: boolean) {
  const source = texture.image;
const bytes = source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray;
if (!bytes && !(source.data instanceof Float32Array) && !(source.data instanceof Int32Array)) {
  throw new Error('Material texture data must be Uint8Array, Uint8ClampedArray, Float32Array or Int32Array.');
}
if (pixelLength(source.data) !== source.width * source.height * 4) {
  throw new Error('Material texture RGBA source length does not match its dimensions.');
}
for (let y = 0; y < placement.height; y++) {
  let sourceY = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / placement.height));
  if (texture.flipY) sourceY = source.height - 1 - sourceY;
  for (let x = 0; x < placement.width; x++) {
    const sourceX = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / placement.width));
    const sourceOffset = (sourceY * source.width + sourceX) * 4;
    const targetOffset = ((placement.y + y) * width + placement.x + x) * 4;
    for (let c = 0; c < 4; c++) {
      const value = pixelValue(source.data, sourceOffset + c);
      writeAtlasPixel(data, targetOffset + c, floatStorage ? float16Bits(bytes ? value / 255 : value) : value);
    }
  }
}
}
