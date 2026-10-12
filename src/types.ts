/** Two-component vector, as a tuple or float32 storage. */
export type Vec2 = [number, number] | Float32Array;
/** Three-component vector, as a tuple or float32 storage. */
export type Vec3 = [number, number, number] | Float32Array;
/** Column-major 4×4 matrix (16 elements). */
export type Mat4 = Float32Array | number[];

export type ColorRGB = [number, number, number];
export type ColorRGBA = [number, number, number, number];
export type Color = ColorRGB | ColorRGBA;

export interface WritableArrayLike<T> {
  readonly length: number;
  [n: number]: T;
}
