// Adapted from gl-matrix 3.4.4, https://github.com/toji/gl-matrix/tree/v3.4.4/src
// Copyright (c) 2015-2025 Brandon Jones and Colin MacKenzie IV, MIT.
// See LICENSES/GlMatrix-MIT.txt. Arithmetic/order retained; creators use Float32Array.
import { read, write } from './access.js';
import type { MathArray, ReadonlyMathArray } from './types.js';

export function create(): Float32Array {
  var out = new Float32Array(9);
  write(out, 0, 1);
  write(out, 4, 1);
  write(out, 8, 1);
  return out;
}

export function fromMat4<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  write(out, 0, read(a, 0));
  write(out, 1, read(a, 1));
  write(out, 2, read(a, 2));
  write(out, 3, read(a, 4));
  write(out, 4, read(a, 5));
  write(out, 5, read(a, 6));
  write(out, 6, read(a, 8));
  write(out, 7, read(a, 9));
  write(out, 8, read(a, 10));
  return out;
}

export function normalFromMat4<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 | null {
  var a00 = read(a, 0),
    a01 = read(a, 1),
    a02 = read(a, 2),
    a03 = read(a, 3);
  var a10 = read(a, 4),
    a11 = read(a, 5),
    a12 = read(a, 6),
    a13 = read(a, 7);
  var a20 = read(a, 8),
    a21 = read(a, 9),
    a22 = read(a, 10),
    a23 = read(a, 11);
  var a30 = read(a, 12),
    a31 = read(a, 13),
    a32 = read(a, 14),
    a33 = read(a, 15);
  var b00 = a00 * a11 - a01 * a10;
  var b01 = a00 * a12 - a02 * a10;
  var b02 = a00 * a13 - a03 * a10;
  var b03 = a01 * a12 - a02 * a11;
  var b04 = a01 * a13 - a03 * a11;
  var b05 = a02 * a13 - a03 * a12;
  var b06 = a20 * a31 - a21 * a30;
  var b07 = a20 * a32 - a22 * a30;
  var b08 = a20 * a33 - a23 * a30;
  var b09 = a21 * a32 - a22 * a31;
  var b10 = a21 * a33 - a23 * a31;
  var b11 = a22 * a33 - a23 * a32;

  // Calculate the determinant
  var det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) {
    return null;
  }
  det = 1.0 / det;
  write(out, 0, (a11 * b11 - a12 * b10 + a13 * b09) * det);
  write(out, 1, (a12 * b08 - a10 * b11 - a13 * b07) * det);
  write(out, 2, (a10 * b10 - a11 * b08 + a13 * b06) * det);
  write(out, 3, (a02 * b10 - a01 * b11 - a03 * b09) * det);
  write(out, 4, (a00 * b11 - a02 * b08 + a03 * b07) * det);
  write(out, 5, (a01 * b08 - a00 * b10 - a03 * b06) * det);
  write(out, 6, (a31 * b05 - a32 * b04 + a33 * b03) * det);
  write(out, 7, (a32 * b02 - a30 * b05 - a33 * b01) * det);
  write(out, 8, (a30 * b04 - a31 * b02 + a33 * b00) * det);
  return out;
}

export type Mat3Array = Float32Array | number[];
