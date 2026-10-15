export interface TextureImageSize { width: number; height: number; }

// Pixel/image storage belongs to the platform adapter. Shared code only needs
// dimensions, identity and sampling metadata; it never owns a browser image.
export default class TextureState {
  image: TextureImageSize;
  version = 0;
  /** Flip the image vertically when uploading. Default `false`. */
  flipY: boolean = false;
  /** UV repeat applied before sampling this texture. Default `[1, 1]`. */
  uvScale: [number, number] = [1, 1];
  /** UV translation applied after repeat and before wrapping. Default `[0, 0]`. */
  uvOffset: [number, number] = [0, 0];
  /** Geometry UV set used by this texture (Three.js Texture.channel). Default `0`. */
  uvChannel: 0 | 1 = 0;
  constructor(image: TextureImageSize) { this.image = image; }

  /**
   * Call after editing image pixels or UV array elements in place. Increments
   * version so the next render refreshes all materials, lights and backgrounds
   * using this texture. Assigning a new image, UV array, flipY or uvChannel is
   * detected automatically.
   */
  markUpdated() {
    this.version++;
    return this;
  }
}
