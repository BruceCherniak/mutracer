import type {ReadonlyMathArray} from './types.js';
import type {MathArray} from './types.js';
import {write} from './access.js';

/** Internal numeric storage preserves source values without float32 rounding. */
export function matrixStorage(source: ReadonlyMathArray): Float64Array {
  if (source instanceof Float64Array) return source;
  if (source instanceof Float32Array) return new Float64Array(source);
  return new Float64Array(source);
}

/** Copy to retained caller storage after selecting its representation once. */
export function copyNumericStorage(destination: MathArray, source: Float64Array): void {
  if (destination instanceof Float32Array) return copyStorage(destination, source);
  if (destination instanceof Float64Array) return copyStorage(destination, source);
  return copyStorage(destination, source);
}
function copyStorage<T extends MathArray>(destination: T, source: Float64Array): void {
  for (let i = 0; i < source.length; i++) write(destination, i, source[i]);
}
