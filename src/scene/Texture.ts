/** Raw pixel data, RGBA, rows top to bottom. Float data is treated as linear HDR. */
export interface TextureDataSource {
  data: Float32Array | Uint8Array | Int32Array;
  width: number;
  height: number;
}

/**
 * Image used by materials, lights and backgrounds. 8-bit color textures are
 * treated as sRGB; float data as linear.
 */
export default class Texture {
  image: HTMLImageElement | HTMLCanvasElement | TextureDataSource;
  /** Optional stable identity of the texture in an adapter such as Three.js. */
  source?: object;
  /** Internal key used to reuse CPU height analysis inside a worker. */
  tessellationCacheKey?: string;
  /** @internal */
  needsUpdate: boolean = true;
  /** Incremented by `markUpdated()`. */
  version = 0;

  /** Flip the image vertically when uploading. Default `false`. */
  flipY: boolean = false;
  /** UV repeat applied before sampling this texture. */
  uvScale: [number, number] = [1, 1];
  /** UV translation applied after repeat and before wrapping. */
  uvOffset: [number, number] = [0, 0];
  /** Geometry UV set used by this texture (Three.js Texture.channel). */
  uvChannel: 0 | 1 = 0;
  constructor(image: HTMLImageElement | HTMLCanvasElement | TextureDataSource) {
    this.image = image;
  }

  /**
   * Call after changing the image contents in place. Then call
   * `renderer.markMeshesDirty()` so the next frame uploads it.
   */
  markUpdated() {
    this.version++;
    this.needsUpdate = true;
    return this;
  }
}

export function isTextureDataSource(
  image: unknown
): image is TextureDataSource {
  return !!(image && (image as TextureDataSource).data);
}

