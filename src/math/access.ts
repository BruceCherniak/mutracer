import type { MathArray, ReadonlyMathArray } from './types.js';

export function read(array: ReadonlyMathArray, index: number): number {
  return array[index];
}
export function write(array: MathArray, index: number, value: number): void {
  array[index] = value;
}
export function size(array: ReadonlyMathArray): number {
  return array.length;
}
