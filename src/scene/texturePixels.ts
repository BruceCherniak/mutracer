import type { TextureDataSource } from './textureData.js';
type PixelData = TextureDataSource['data'];

export function pixelLength(data: PixelData): number {
  return data.length;
}
export function pixelValue(data: PixelData, index: number): number {
  return data[index];
}
export function writePixel(data: PixelData, index: number, value: number): void {
  data[index] = value;
}
