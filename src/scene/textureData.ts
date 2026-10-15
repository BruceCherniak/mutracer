/** Raw RGBA pixels, rows top to bottom. Bytes encode sRGB color; float data is linear HDR. */
export interface TextureDataSource {
  /** Required RGBA pixels in row-major order. Uint8Array/Uint8ClampedArray encode sRGB color; Float32Array/Int32Array contain linear values. Data-map channels are always linear. */
  data: Float32Array | Uint8Array | Uint8ClampedArray | Int32Array;
  /** Required pixel width. */
  width: number;
  /** Required pixel height. */
  height: number;
}
