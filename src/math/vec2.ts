// Adapted from gl-matrix 3.4.4, https://github.com/toji/gl-matrix/tree/v3.4.4/src
// Copyright (c) 2015-2025 Brandon Jones and Colin MacKenzie IV, MIT.
// See LICENSES/GlMatrix-MIT.txt. Arithmetic/order retained; creators use Float32Array.
import type { MathArray, ReadonlyMathArray } from './types.js';

export function copy<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  out[0] = a[0];
  out[1] = a[1];
  return out;
}

export function create(): Float32Array {
  var out = new Float32Array(2);
  return out;
}

export const len = length;

export function length<T0 extends ReadonlyMathArray>(a: T0): number {
  var x = a[0],
    y = a[1];
  return Math.sqrt(x * x + y * y);
}

export function max<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  out[0] = Math.max(a[0], b[0]);
  out[1] = Math.max(a[1], b[1]);
  return out;
}

export function min<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  out[0] = Math.min(a[0], b[0]);
  out[1] = Math.min(a[1], b[1]);
  return out;
}

export function normalize<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  var x = a[0],
    y = a[1];
  var len = x * x + y * y;
  if (len > 0) {
    //TODO: evaluate use of glm_invsqrt here?
    len = 1 / Math.sqrt(len);
  }
  out[0] = a[0] * len;
  out[1] = a[1] * len;
  return out;
}

export function scale<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1, b: number): T0 {
  out[0] = a[0] * b;
  out[1] = a[1] * b;
  return out;
}

export function set<T0 extends MathArray>(out: T0, x: number, y: number): T0 {
  out[0] = x;
  out[1] = y;
  return out;
}

export const sub = subtract;

export function subtract<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  out[0] = a[0] - b[0];
  out[1] = a[1] - b[1];
  return out;
}

export type Vec2Array = Float32Array | number[];
