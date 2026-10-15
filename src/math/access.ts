import type { MathArray, ReadonlyMathArray } from './types.js';

// Narrow storage explicitly: scriptc cannot index a generic typed-array union.
// These helpers keep ordinary arrays and float64 scratch storage supported too.
export function read(array: ReadonlyMathArray, index: number): number {
  if (array instanceof Float32Array) return array[index];
  if (array instanceof Float64Array) return array[index];
  return array[index];
}

export function write(array: MathArray, index: number, value: number): void {
  if (array instanceof Float32Array) { array[index] = value; return; }
  if (array instanceof Float64Array) { array[index] = value; return; }
  array[index] = value;
}

export function size(array: ReadonlyMathArray): number {
  if (array instanceof Float32Array) return array.length;
  if (array instanceof Float64Array) return array.length;
  return array.length;
}
