import type { ProceduralSkyImage } from './skyParameters.js';
import TextureState from './TextureState.js';
export type { TextureColorSpace, TextureWrapMode } from './TextureState.js';
export { textureWrapIndex } from './TextureState.js';
import type { TextureDataSource } from './textureData.js';
export type { TextureDataSource } from './textureData.js';

/**
 * Image used by materials, lights and backgrounds. Material color slots default
 * to sRGB for images/bytes and linear for float data; colorSpace overrides this.
 */
export default class Texture extends TextureState {
  /** Texture source supplied to the constructor; no default. */
  declare image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas | TextureDataSource | ProceduralSkyImage;
  /** Optional stable identity of the texture in an adapter such as Three.js. */
  source?: object;
  constructor(image: HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas | TextureDataSource | ProceduralSkyImage) {
    super(image);
  }
}

export function isTextureDataSource(
  image: unknown
): image is TextureDataSource {
  return !!(image && (image as TextureDataSource).data);
}

