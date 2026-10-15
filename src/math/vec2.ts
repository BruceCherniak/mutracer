// Adapted from gl-matrix 3.4.4, https://github.com/toji/gl-matrix/tree/v3.4.4/src
// Copyright (c) 2015-2025 Brandon Jones and Colin MacKenzie IV, MIT.
// See LICENSES/GlMatrix-MIT.txt. Arithmetic/order retained; creators use Float32Array.
import { read, write } from './access.js';
import type { MathArray, ReadonlyMathArray } from './types.js';

export function copy<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  write(out, 0, read(a, 0));
  write(out, 1, read(a, 1));
  return out;
}

export function create(): Float32Array {
  var out = new Float32Array(2);
  return out;
}

export const len = length;

export function length<T0 extends ReadonlyMathArray>(a: T0): number {
  var x = read(a, 0),
    y = read(a, 1);
  return Math.sqrt(x * x + y * y);
}

export function max<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  write(out, 0, Math.max(read(a, 0), read(b, 0)));
  write(out, 1, Math.max(read(a, 1), read(b, 1)));
  return out;
}

export function min<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  write(out, 0, Math.min(read(a, 0), read(b, 0)));
  write(out, 1, Math.min(read(a, 1), read(b, 1)));
  return out;
}

export function normalize<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  var x = read(a, 0),
    y = read(a, 1);
  var len = x * x + y * y;
  if (len > 0) {
    //TODO: evaluate use of glm_invsqrt here?
    len = 1 / Math.sqrt(len);
  }
  write(out, 0, read(a, 0) * len);
  write(out, 1, read(a, 1) * len);
  return out;
}

export function scale<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1, b: number): T0 {
  write(out, 0, read(a, 0) * b);
  write(out, 1, read(a, 1) * b);
  return out;
}

export function set<T0 extends MathArray>(out: T0, x: number, y: number): T0 {
  write(out, 0, x);
  write(out, 1, y);
  return out;
}

export const sub = subtract;

export function subtract<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  write(out, 0, read(a, 0) - read(b, 0));
  write(out, 1, read(a, 1) - read(b, 1));
  return out;
}

export type Vec2Array = Float32Array | number[];
