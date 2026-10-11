/** Raw pixel data, RGBA, rows top to bottom. Float data is treated as linear HDR. */
export interface TextureDataSource {
  /** Required RGBA pixels in row-major order; float data is linear HDR. */
  data: Float32Array | Uint8Array | Int32Array;
  /** Required pixel width. */
  width: number;
  /** Required pixel height. */
  height: number;
}

/**
 * Image used by materials, lights and backgrounds. 8-bit color textures are
 * treated as sRGB; float data as linear.
 */
export default class Texture {
  /** Image or raw RGBA pixels supplied to the constructor; no default. */
  image: HTMLImageElement | HTMLCanvasElement | TextureDataSource;
  /** Optional stable identity of the texture in an adapter such as Three.js. */
  source?: object;
  /** @internal */
  needsUpdate: boolean = true;
  /** Incremented by `markUpdated()`. */
  version = 0;

  /** Flip the image vertically when uploading. Default `false`. */
  flipY: boolean = false;
  /** UV repeat applied before sampling this texture. Default `[1, 1]`. */
  uvScale: [number, number] = [1, 1];
  /** UV translation applied after repeat and before wrapping. Default `[0, 0]`. */
  uvOffset: [number, number] = [0, 0];
  /** Geometry UV set used by this texture (Three.js Texture.channel). Default `0`. */
  uvChannel: 0 | 1 = 0;
  constructor(image: HTMLImageElement | HTMLCanvasElement | TextureDataSource) {
    this.image = image;
  }

  /**
   * Call after editing image pixels or UV array elements in place. Increments
   * version so the next render refreshes all materials, lights and backgrounds
   * using this texture. Assigning a new image, UV array, flipY or uvChannel is
   * detected automatically.
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

