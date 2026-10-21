/** Raw RGBA pixels, rows top to bottom. Color encoding defaults to sRGB for bytes and linear for floats. */
export interface TextureDataSource {
  /** Required RGBA pixels in row-major order. Uint8Array/Uint8ClampedArray default to sRGB color; Float32Array/Int32Array default to linear values. Texture.colorSpace can override color encoding; data-map channels are always linear. */
  data: Float32Array | Uint8Array | Uint8ClampedArray | Int32Array;
  /** Required pixel width. */
  width: number;
  /** Required pixel height. */
  height: number;
}
