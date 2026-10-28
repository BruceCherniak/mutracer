import type { TextureDataSource } from '../scene/textureData.js';
import { pixelLength, pixelValue } from '../scene/texturePixels.js';
import type { AtlasPlacement } from './textureAtlas.js';
import { float16Bits } from './float16.js';

export function writeAtlasPixel(data: Uint16Array | Uint8Array, index: number, value: number) {
  data[index] = value;
}
export function writeRawAtlasPlacement(data: Uint16Array | Uint8Array, width: number,
  placement: AtlasPlacement, texture: {image: TextureDataSource; flipY: boolean}, floatStorage: boolean) {
  const source = texture.image;
  const bytes = source.data instanceof Uint8Array || source.data instanceof Uint8ClampedArray;
  if (!bytes && !(source.data instanceof Float32Array) && !(source.data instanceof Int32Array)) {
    throw new Error('Material texture data must be Uint8Array, Uint8ClampedArray, Float32Array or Int32Array.');
  }
  // A row copy is identical to nearest-neighbour sampling at unit scale. Keep
  // the scalar path for aliases: its left-to-right overwrite order is observable.
  if (!floatStorage && data instanceof Uint8Array && placement.width === source.width && placement.height === source.height) {
    if (source.data instanceof Uint8Array) {
      if (copyAtlasRows(data, width, placement, source.data, source.width, source.height, texture.flipY)) return;
    }
    if (source.data instanceof Uint8ClampedArray) {
      if (copyAtlasRows(data, width, placement, source.data, source.width, source.height, texture.flipY)) return;
    }
  }
  if (data instanceof Uint16Array) return writeAtlasSource(data, width, placement, texture, floatStorage);
  return writeAtlasSource(data, width, placement, texture, floatStorage);
}

function copyAtlasRows<S extends Uint8Array | Uint8ClampedArray>(data: Uint8Array, width: number,
  placement: AtlasPlacement, source: S, sourceWidth: number, sourceHeight: number, flipY: boolean) {
  if (pixelLength(source) !== sourceWidth * sourceHeight * 4) throw new Error('Material texture RGBA source length does not match its dimensions.');
  if (source.buffer === data.buffer) return false;
  const rowBytes = sourceWidth * 4;
  for (let y = 0; y < placement.height; y++) {
    const sourceY = flipY ? sourceHeight - y - 1 : y;
    data.set(source.subarray(sourceY * rowBytes, (sourceY + 1) * rowBytes), ((placement.y + y) * width + placement.x) * 4);
  }
  return true;
}

function writeAtlasSource<D extends Uint16Array | Uint8Array>(data: D, width: number,
  placement: AtlasPlacement, texture: {image: TextureDataSource; flipY: boolean}, floatStorage: boolean) {
  const source = texture.image;
  if (source.data instanceof Uint8Array) return writeAtlasKernel(data, width, placement, source.data, source.width, source.height, texture.flipY, floatStorage, 255);
  if (source.data instanceof Uint8ClampedArray) return writeAtlasKernel(data, width, placement, source.data, source.width, source.height, texture.flipY, floatStorage, 255);
  if (source.data instanceof Float32Array) return writeAtlasKernel(data, width, placement, source.data, source.width, source.height, texture.flipY, floatStorage, 1);
  return writeAtlasKernel(data, width, placement, source.data, source.width, source.height, texture.flipY, floatStorage, 1);
}

function writeAtlasKernel<D extends Uint16Array | Uint8Array, S extends TextureDataSource['data']>(
  data: D, width: number, placement: AtlasPlacement, source: S,
  sourceWidth: number, sourceHeight: number, flipY: boolean, floatStorage: boolean, scale: number) {
  if (pixelLength(source) !== sourceWidth * sourceHeight * 4) throw new Error('Material texture RGBA source length does not match its dimensions.');
  for (let y = 0; y < placement.height; y++) {
    let sourceY = Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / placement.height));
    if (flipY) sourceY = sourceHeight - 1 - sourceY;
    for (let x = 0; x < placement.width; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / placement.width));
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4;
      const targetOffset = ((placement.y + y) * width + placement.x + x) * 4;
      for (let c = 0; c < 4; c++) {
        const value = pixelValue(source, sourceOffset + c);
        writeAtlasPixel(data, targetOffset + c, floatStorage ? float16Bits(value / scale) : value);
      }
    }
  }
}
