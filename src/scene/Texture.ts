import TextureState from './TextureState.js';
import type { TextureDataSource } from './textureData.js';
export type { TextureDataSource } from './textureData.js';

/**
 * Image used by materials, lights and backgrounds. 8-bit color textures are
 * treated as sRGB; float data as linear.
 */
export default class Texture extends TextureState {
  /** Image or raw RGBA pixels supplied to the constructor; no default. */
  declare image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas | TextureDataSource;
  /** Optional stable identity of the texture in an adapter such as Three.js. */
  source?: object;
  constructor(image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas | TextureDataSource) {
    super(image);
  }
}

export function isTextureDataSource(
  image: unknown
): image is TextureDataSource {
  return !!(image && (image as TextureDataSource).data);
}

