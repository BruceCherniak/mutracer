import type { TextureDataSource } from './textureData.js';
type PixelData = TextureDataSource['data'];

export function pixelLength(data: PixelData): number {
  if (data instanceof Float32Array) return data.length;
  if (data instanceof Int32Array) return data.length;
  if (data instanceof Uint8Array) return data.length;
  return data.length;
}
export function pixelValue(data: PixelData, index: number): number {
  if (data instanceof Float32Array) return data[index];
  if (data instanceof Int32Array) return data[index];
  if (data instanceof Uint8Array) return data[index];
  return data[index];
}
export function writePixel(data: PixelData, index: number, value: number): void {
  if (data instanceof Float32Array) { data[index] = value; return; }
  if (data instanceof Int32Array) { data[index] = value; return; }
  if (data instanceof Uint8Array) { data[index] = value; return; }
  data[index] = value;
}
