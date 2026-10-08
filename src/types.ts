export type ColorRGB = [number, number, number];
export type ColorRGBA = [number, number, number, number];
export type Color = ColorRGB | ColorRGBA;

export interface WritableArrayLike<T> {
  readonly length: number;
  [n: number]: T;
}
