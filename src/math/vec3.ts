// Adapted from gl-matrix 3.4.4, https://github.com/toji/gl-matrix/tree/v3.4.4/src
// Copyright (c) 2015-2025 Brandon Jones and Colin MacKenzie IV, MIT.
// See LICENSES/GlMatrix-MIT.txt. Arithmetic/order retained; creators use Float32Array.
import { read, write, size } from './access.js';
import type { MathArray, ReadonlyMathArray } from './types.js';

export function clone<T0 extends ReadonlyMathArray>(a: T0): Float32Array {
  var out = new Float32Array(3);
  write(out, 0, read(a, 0));
  write(out, 1, read(a, 1));
  write(out, 2, read(a, 2));
  return out;
}

export function copy<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  write(out, 0, read(a, 0));
  write(out, 1, read(a, 1));
  write(out, 2, read(a, 2));
  return out;
}

export function create(): Float32Array {
  var out = new Float32Array(3);
  return out;
}

export function cross<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  var ax = read(a, 0),
    ay = read(a, 1),
    az = read(a, 2);
  var bx = read(b, 0),
    by = read(b, 1),
    bz = read(b, 2);
  write(out, 0, ay * bz - az * by);
  write(out, 1, az * bx - ax * bz);
  write(out, 2, ax * by - ay * bx);
  return out;
}

export const dist = distance;

export function distance<T0 extends ReadonlyMathArray, T1 extends ReadonlyMathArray>(a: T0, b: T1): number {
  var x = read(b, 0) - read(a, 0);
  var y = read(b, 1) - read(a, 1);
  var z = read(b, 2) - read(a, 2);
  return Math.sqrt(x * x + y * y + z * z);
}

export function fromValues(x: number, y: number, z: number): Float32Array {
  var out = new Float32Array(3);
  write(out, 0, x);
  write(out, 1, y);
  write(out, 2, z);
  return out;
}

export function length<T0 extends ReadonlyMathArray>(a: T0): number {
  var x = read(a, 0);
  var y = read(a, 1);
  var z = read(a, 2);
  return Math.sqrt(x * x + y * y + z * z);
}

export function lerp<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2, t: number): T0 {
  var ax = read(a, 0);
  var ay = read(a, 1);
  var az = read(a, 2);
  write(out, 0, ax + t * (read(b, 0) - ax));
  write(out, 1, ay + t * (read(b, 1) - ay));
  write(out, 2, az + t * (read(b, 2) - az));
  return out;
}

export function max<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  write(out, 0, Math.max(read(a, 0), read(b, 0)));
  write(out, 1, Math.max(read(a, 1), read(b, 1)));
  write(out, 2, Math.max(read(a, 2), read(b, 2)));
  return out;
}

export function min<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  write(out, 0, Math.min(read(a, 0), read(b, 0)));
  write(out, 1, Math.min(read(a, 1), read(b, 1)));
  write(out, 2, Math.min(read(a, 2), read(b, 2)));
  return out;
}

export function normalize<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  var x = read(a, 0);
  var y = read(a, 1);
  var z = read(a, 2);
  var len = x * x + y * y + z * z;
  if (len > 0) {
    //TODO: evaluate use of glm_invsqrt here?
    len = 1 / Math.sqrt(len);
  }
  write(out, 0, read(a, 0) * len);
  write(out, 1, read(a, 1) * len);
  write(out, 2, read(a, 2) * len);
  return out;
}

export const len = length;

export function scale<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1, b: number): T0 {
  write(out, 0, read(a, 0) * b);
  write(out, 1, read(a, 1) * b);
  write(out, 2, read(a, 2) * b);
  return out;
}

export function scaleAndAdd<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2, scale: number): T0 {
  write(out, 0, read(a, 0) + read(b, 0) * scale);
  write(out, 1, read(a, 1) + read(b, 1) * scale);
  write(out, 2, read(a, 2) + read(b, 2) * scale);
  return out;
}

export function set<T0 extends MathArray>(out: T0, x: number, y: number, z: number): T0 {
  write(out, 0, x);
  write(out, 1, y);
  write(out, 2, z);
  return out;
}

export const sub = subtract;

export function subtract<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
  write(out, 0, read(a, 0) - read(b, 0));
  write(out, 1, read(a, 1) - read(b, 1));
  write(out, 2, read(a, 2) - read(b, 2));
  return out;
}

export function transformMat3<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, m: T2): T0 {
  var x = read(a, 0),
    y = read(a, 1),
    z = read(a, 2);
  write(out, 0, x * read(m, 0) + y * read(m, 3) + z * read(m, 6));
  write(out, 1, x * read(m, 1) + y * read(m, 4) + z * read(m, 7));
  write(out, 2, x * read(m, 2) + y * read(m, 5) + z * read(m, 8));
  return out;
}

export function transformMat4<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, m: T2): T0 {
  var x = read(a, 0),
    y = read(a, 1),
    z = read(a, 2);
  var w = read(m, 3) * x + read(m, 7) * y + read(m, 11) * z + read(m, 15);
  w = w || 1.0;
  write(out, 0, (read(m, 0) * x + read(m, 4) * y + read(m, 8) * z + read(m, 12)) / w);
  write(out, 1, (read(m, 1) * x + read(m, 5) * y + read(m, 9) * z + read(m, 13)) / w);
  write(out, 2, (read(m, 2) * x + read(m, 6) * y + read(m, 10) * z + read(m, 14)) / w);
  return out;
}

const forEachVector = create();
export function forEach<T extends MathArray, A = undefined>(a: T, stride: number | undefined, offset: number | undefined, count: number | undefined, fn: (out: Float32Array, input: Float32Array, arg: A) => unknown, arg?: A): T {
  stride = stride || 3; offset = offset || 0;
  const end = count ? Math.min(count * stride + offset, size(a)) : size(a);
  for (let i = offset; i < end; i += stride) {
    write(forEachVector, 0, read(a, i)); write(forEachVector, 1, read(a, i + 1)); write(forEachVector, 2, read(a, i + 2));
    fn(forEachVector, forEachVector, arg as A);
    write(a, i, read(forEachVector, 0)); write(a, i + 1, read(forEachVector, 1)); write(a, i + 2, read(forEachVector, 2));
  }
  return a;
}

export type Vec3Array = Float32Array | number[];
