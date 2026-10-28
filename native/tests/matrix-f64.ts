import {mat3, mat4, vec3} from '../../src/math.js';

// Explicit Float64 storage is shared with the raw core. The JS oracle uses
// upstream gl-matrix with explicit Float64 outputs, independent of this adapter.
export function matrixParameters(bytes: Uint8Array): Uint8Array {
  const input = new Float64Array(bytes.buffer, bytes.byteOffset, 32);
  const product = mat4.multiply(mat4.identity(new Float64Array(16)), input.slice(0, 16), input.slice(16, 32));
  const inverse = mat4.invert(mat4.identity(new Float64Array(16)), product)!;
  const point = vec3.transformMat4(new Float32Array(3), new Float32Array([.1, .2, .3]), product);
  const normal = mat3.normalFromMat4(new Float64Array(9), product)!;
  const result = new Float64Array(46);
  result[0] = product.byteLength / 16; result[1] = normal.byteLength / 9;
  result.set(product, 2); result.set(inverse, 18); result.set(point, 34); result.set(normal, 37);
  return new Uint8Array(result.buffer);
}
