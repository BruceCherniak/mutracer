// Adapted from gl-matrix 3.4.4, https://github.com/toji/gl-matrix/tree/v3.4.4/src
// Copyright (c) 2015-2025 Brandon Jones and Colin MacKenzie IV, MIT.
// See LICENSES/GlMatrix-MIT.txt. Arithmetic/order retained; creators use Float32Array.
import { read, write } from './access.js';
import type { MathArray, ReadonlyMathArray } from './types.js';
const EPSILON = 0.000001;

export function copy<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 {
  write(out, 0, read(a, 0));
  write(out, 1, read(a, 1));
  write(out, 2, read(a, 2));
  write(out, 3, read(a, 3));
  write(out, 4, read(a, 4));
  write(out, 5, read(a, 5));
  write(out, 6, read(a, 6));
  write(out, 7, read(a, 7));
  write(out, 8, read(a, 8));
  write(out, 9, read(a, 9));
  write(out, 10, read(a, 10));
  write(out, 11, read(a, 11));
  write(out, 12, read(a, 12));
  write(out, 13, read(a, 13));
  write(out, 14, read(a, 14));
  write(out, 15, read(a, 15));
  return out;
}

export function create(): Float32Array {
  var out = new Float32Array(16);
  write(out, 0, 1);
  write(out, 5, 1);
  write(out, 10, 1);
  write(out, 15, 1);
  return out;
}

export function invert<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1): T0 | null {
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
  write(out, 1, (a02 * b10 - a01 * b11 - a03 * b09) * det);
  write(out, 2, (a31 * b05 - a32 * b04 + a33 * b03) * det);
  write(out, 3, (a22 * b04 - a21 * b05 - a23 * b03) * det);
  write(out, 4, (a12 * b08 - a10 * b11 - a13 * b07) * det);
  write(out, 5, (a00 * b11 - a02 * b08 + a03 * b07) * det);
  write(out, 6, (a32 * b02 - a30 * b05 - a33 * b01) * det);
  write(out, 7, (a20 * b05 - a22 * b02 + a23 * b01) * det);
  write(out, 8, (a10 * b10 - a11 * b08 + a13 * b06) * det);
  write(out, 9, (a01 * b08 - a00 * b10 - a03 * b06) * det);
  write(out, 10, (a30 * b04 - a31 * b02 + a33 * b00) * det);
  write(out, 11, (a21 * b02 - a20 * b04 - a23 * b00) * det);
  write(out, 12, (a11 * b07 - a10 * b09 - a12 * b06) * det);
  write(out, 13, (a00 * b09 - a01 * b07 + a02 * b06) * det);
  write(out, 14, (a31 * b01 - a30 * b03 - a32 * b00) * det);
  write(out, 15, (a20 * b03 - a21 * b01 + a22 * b00) * det);
  return out;
}

export function lookAt<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray, T3 extends ReadonlyMathArray>(out: T0, eye: T1, center: T2, up: T3): T0 {
  var x0, x1, x2, y0, y1, y2, z0, z1, z2, len;
  var eyex = read(eye, 0);
  var eyey = read(eye, 1);
  var eyez = read(eye, 2);
  var upx = read(up, 0);
  var upy = read(up, 1);
  var upz = read(up, 2);
  var centerx = read(center, 0);
  var centery = read(center, 1);
  var centerz = read(center, 2);
  if (Math.abs(eyex - centerx) < EPSILON && Math.abs(eyey - centery) < EPSILON && Math.abs(eyez - centerz) < EPSILON) {
    return identity(out);
  }
  z0 = eyex - centerx;
  z1 = eyey - centery;
  z2 = eyez - centerz;
  len = 1 / Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
  z0 = z0 * len;
  z1 = z1 * len;
  z2 = z2 * len;
  x0 = upy * z2 - upz * z1;
  x1 = upz * z0 - upx * z2;
  x2 = upx * z1 - upy * z0;
  len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
  if (!len) {
    x0 = 0;
    x1 = 0;
    x2 = 0;
  } else {
    len = 1 / len;
    x0 = x0 * len;
    x1 = x1 * len;
    x2 = x2 * len;
  }
  y0 = z1 * x2 - z2 * x1;
  y1 = z2 * x0 - z0 * x2;
  y2 = z0 * x1 - z1 * x0;
  len = Math.sqrt(y0 * y0 + y1 * y1 + y2 * y2);
  if (!len) {
    y0 = 0;
    y1 = 0;
    y2 = 0;
  } else {
    len = 1 / len;
    y0 = y0 * len;
    y1 = y1 * len;
    y2 = y2 * len;
  }
  write(out, 0, x0);
  write(out, 1, y0);
  write(out, 2, z0);
  write(out, 3, 0);
  write(out, 4, x1);
  write(out, 5, y1);
  write(out, 6, z1);
  write(out, 7, 0);
  write(out, 8, x2);
  write(out, 9, y2);
  write(out, 10, z2);
  write(out, 11, 0);
  write(out, 12, -(x0 * eyex + x1 * eyey + x2 * eyez));
  write(out, 13, -(y0 * eyex + y1 * eyey + y2 * eyez));
  write(out, 14, -(z0 * eyex + z1 * eyey + z2 * eyez));
  write(out, 15, 1);
  return out;
}

export function identity<T0 extends MathArray>(out: T0): T0 {
  write(out, 0, 1);
  write(out, 1, 0);
  write(out, 2, 0);
  write(out, 3, 0);
  write(out, 4, 0);
  write(out, 5, 1);
  write(out, 6, 0);
  write(out, 7, 0);
  write(out, 8, 0);
  write(out, 9, 0);
  write(out, 10, 1);
  write(out, 11, 0);
  write(out, 12, 0);
  write(out, 13, 0);
  write(out, 14, 0);
  write(out, 15, 1);
  return out;
}

export function targetTo<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray, T3 extends ReadonlyMathArray>(out: T0, eye: T1, target: T2, up: T3): T0 {
  var eyex = read(eye, 0),
    eyey = read(eye, 1),
    eyez = read(eye, 2),
    upx = read(up, 0),
    upy = read(up, 1),
    upz = read(up, 2);
  var z0 = eyex - read(target, 0),
    z1 = eyey - read(target, 1),
    z2 = eyez - read(target, 2);
  var len = z0 * z0 + z1 * z1 + z2 * z2;
  if (len > 0) {
    len = 1 / Math.sqrt(len);
    z0 = z0 * len;
    z1 = z1 * len;
    z2 = z2 * len;
  }
  var x0 = upy * z2 - upz * z1,
    x1 = upz * z0 - upx * z2,
    x2 = upx * z1 - upy * z0;
  len = x0 * x0 + x1 * x1 + x2 * x2;
  if (len > 0) {
    len = 1 / Math.sqrt(len);
    x0 = x0 * len;
    x1 = x1 * len;
    x2 = x2 * len;
  }
  write(out, 0, x0);
  write(out, 1, x1);
  write(out, 2, x2);
  write(out, 3, 0);
  write(out, 4, z1 * x2 - z2 * x1);
  write(out, 5, z2 * x0 - z0 * x2);
  write(out, 6, z0 * x1 - z1 * x0);
  write(out, 7, 0);
  write(out, 8, z0);
  write(out, 9, z1);
  write(out, 10, z2);
  write(out, 11, 0);
  write(out, 12, eyex);
  write(out, 13, eyey);
  write(out, 14, eyez);
  write(out, 15, 1);
  return out;
}

export function getScaling<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, mat: T1): T0 {
  var m11 = read(mat, 0);
  var m12 = read(mat, 1);
  var m13 = read(mat, 2);
  var m21 = read(mat, 4);
  var m22 = read(mat, 5);
  var m23 = read(mat, 6);
  var m31 = read(mat, 8);
  var m32 = read(mat, 9);
  var m33 = read(mat, 10);
  write(out, 0, Math.sqrt(m11 * m11 + m12 * m12 + m13 * m13));
  write(out, 1, Math.sqrt(m21 * m21 + m22 * m22 + m23 * m23));
  write(out, 2, Math.sqrt(m31 * m31 + m32 * m32 + m33 * m33));
  return out;
}

export const mul = multiply;

export function multiply<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, b: T2): T0 {
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

  // Cache only the current line of the second matrix
  var b0 = read(b, 0),
    b1 = read(b, 1),
    b2 = read(b, 2),
    b3 = read(b, 3);
  write(out, 0, b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30);
  write(out, 1, b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31);
  write(out, 2, b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32);
  write(out, 3, b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33);
  b0 = read(b, 4);
  b1 = read(b, 5);
  b2 = read(b, 6);
  b3 = read(b, 7);
  write(out, 4, b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30);
  write(out, 5, b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31);
  write(out, 6, b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32);
  write(out, 7, b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33);
  b0 = read(b, 8);
  b1 = read(b, 9);
  b2 = read(b, 10);
  b3 = read(b, 11);
  write(out, 8, b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30);
  write(out, 9, b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31);
  write(out, 10, b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32);
  write(out, 11, b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33);
  b0 = read(b, 12);
  b1 = read(b, 13);
  b2 = read(b, 14);
  b3 = read(b, 15);
  write(out, 12, b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30);
  write(out, 13, b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31);
  write(out, 14, b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32);
  write(out, 15, b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33);
  return out;
}

export const ortho = orthoNO;

export function orthoNO<T0 extends MathArray>(out: T0, left: number, right: number, bottom: number, top: number, near: number, far: number): T0 {
  var lr = 1 / (left - right);
  var bt = 1 / (bottom - top);
  var nf = 1 / (near - far);
  write(out, 0, -2 * lr);
  write(out, 1, 0);
  write(out, 2, 0);
  write(out, 3, 0);
  write(out, 4, 0);
  write(out, 5, -2 * bt);
  write(out, 6, 0);
  write(out, 7, 0);
  write(out, 8, 0);
  write(out, 9, 0);
  write(out, 10, 2 * nf);
  write(out, 11, 0);
  write(out, 12, (left + right) * lr);
  write(out, 13, (top + bottom) * bt);
  write(out, 14, (far + near) * nf);
  write(out, 15, 1);
  return out;
}

export const perspective = perspectiveNO;

export function perspectiveNO<T0 extends MathArray>(out: T0, fovy: number, aspect: number, near: number, far: number | null): T0 {
  var f = 1.0 / Math.tan(fovy / 2);
  write(out, 0, f / aspect);
  write(out, 1, 0);
  write(out, 2, 0);
  write(out, 3, 0);
  write(out, 4, 0);
  write(out, 5, f);
  write(out, 6, 0);
  write(out, 7, 0);
  write(out, 8, 0);
  write(out, 9, 0);
  write(out, 11, -1);
  write(out, 12, 0);
  write(out, 13, 0);
  write(out, 15, 0);
  if (far != null && far !== Infinity) {
    var nf = 1 / (near - far);
    write(out, 10, (far + near) * nf);
    write(out, 14, 2 * far * near * nf);
  } else {
    write(out, 10, -1);
    write(out, 14, -2 * near);
  }
  return out;
}

export function scale<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, v: T2): T0 {
  var x = read(v, 0),
    y = read(v, 1),
    z = read(v, 2);
  write(out, 0, read(a, 0) * x);
  write(out, 1, read(a, 1) * x);
  write(out, 2, read(a, 2) * x);
  write(out, 3, read(a, 3) * x);
  write(out, 4, read(a, 4) * y);
  write(out, 5, read(a, 5) * y);
  write(out, 6, read(a, 6) * y);
  write(out, 7, read(a, 7) * y);
  write(out, 8, read(a, 8) * z);
  write(out, 9, read(a, 9) * z);
  write(out, 10, read(a, 10) * z);
  write(out, 11, read(a, 11) * z);
  write(out, 12, read(a, 12));
  write(out, 13, read(a, 13));
  write(out, 14, read(a, 14));
  write(out, 15, read(a, 15));
  return out;
}

export function rotateZ<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, a: T1, rad: number): T0 {
  var s = Math.sin(rad);
  var c = Math.cos(rad);
  var a00 = read(a, 0);
  var a01 = read(a, 1);
  var a02 = read(a, 2);
  var a03 = read(a, 3);
  var a10 = read(a, 4);
  var a11 = read(a, 5);
  var a12 = read(a, 6);
  var a13 = read(a, 7);
  if ((a as ReadonlyMathArray) !== out) {
    // If the source and destination differ, copy the unchanged last row
    write(out, 8, read(a, 8));
    write(out, 9, read(a, 9));
    write(out, 10, read(a, 10));
    write(out, 11, read(a, 11));
    write(out, 12, read(a, 12));
    write(out, 13, read(a, 13));
    write(out, 14, read(a, 14));
    write(out, 15, read(a, 15));
  }

  // Perform axis-specific matrix multiplication
  write(out, 0, a00 * c + a10 * s);
  write(out, 1, a01 * c + a11 * s);
  write(out, 2, a02 * c + a12 * s);
  write(out, 3, a03 * c + a13 * s);
  write(out, 4, a10 * c - a00 * s);
  write(out, 5, a11 * c - a01 * s);
  write(out, 6, a12 * c - a02 * s);
  write(out, 7, a13 * c - a03 * s);
  return out;
}

export function fromScaling<T0 extends MathArray, T1 extends ReadonlyMathArray>(out: T0, v: T1): T0 {
  write(out, 0, read(v, 0));
  write(out, 1, 0);
  write(out, 2, 0);
  write(out, 3, 0);
  write(out, 4, 0);
  write(out, 5, read(v, 1));
  write(out, 6, 0);
  write(out, 7, 0);
  write(out, 8, 0);
  write(out, 9, 0);
  write(out, 10, read(v, 2));
  write(out, 11, 0);
  write(out, 12, 0);
  write(out, 13, 0);
  write(out, 14, 0);
  write(out, 15, 1);
  return out;
}

export function translate<T0 extends MathArray, T1 extends ReadonlyMathArray, T2 extends ReadonlyMathArray>(out: T0, a: T1, v: T2): T0 {
  var x = read(v, 0),
    y = read(v, 1),
    z = read(v, 2);
  var a00, a01, a02, a03;
  var a10, a11, a12, a13;
  var a20, a21, a22, a23;
  if ((a as ReadonlyMathArray) === out) {
    write(out, 12, read(a, 0) * x + read(a, 4) * y + read(a, 8) * z + read(a, 12));
    write(out, 13, read(a, 1) * x + read(a, 5) * y + read(a, 9) * z + read(a, 13));
    write(out, 14, read(a, 2) * x + read(a, 6) * y + read(a, 10) * z + read(a, 14));
    write(out, 15, read(a, 3) * x + read(a, 7) * y + read(a, 11) * z + read(a, 15));
  } else {
    a00 = read(a, 0);
    a01 = read(a, 1);
    a02 = read(a, 2);
    a03 = read(a, 3);
    a10 = read(a, 4);
    a11 = read(a, 5);
    a12 = read(a, 6);
    a13 = read(a, 7);
    a20 = read(a, 8);
    a21 = read(a, 9);
    a22 = read(a, 10);
    a23 = read(a, 11);
    write(out, 0, a00);
    write(out, 1, a01);
    write(out, 2, a02);
    write(out, 3, a03);
    write(out, 4, a10);
    write(out, 5, a11);
    write(out, 6, a12);
    write(out, 7, a13);
    write(out, 8, a20);
    write(out, 9, a21);
    write(out, 10, a22);
    write(out, 11, a23);
    write(out, 12, a00 * x + a10 * y + a20 * z + read(a, 12));
    write(out, 13, a01 * x + a11 * y + a21 * z + read(a, 13));
    write(out, 14, a02 * x + a12 * y + a22 * z + read(a, 14));
    write(out, 15, a03 * x + a13 * y + a23 * z + read(a, 15));
  }
  return out;
}

export type Mat4Array = Float32Array | number[];
