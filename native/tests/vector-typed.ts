import {vec2, vec3} from '../../src/math.js';

// Production lowering must keep scalar rounding and aliasing for each concrete
// storage combination. The independent oracle is upstream gl-matrix.
export function vectorParameters(bytes: Uint8Array): Uint8Array {
  const input = new Float64Array(bytes.buffer, bytes.byteOffset, 6);
  const a = input.slice(0, 3), b = new Float32Array(input.slice(3, 6));
  const f = new Float32Array(a), alias = f.subarray(0, 3);
  const result = new Float64Array(37);
  result.set(vec3.normalize(new Float32Array(3), f), 0);
  result.set(vec3.cross(alias, alias, b), 3);
  result.set(vec3.sub(new Float64Array(3), a, b), 6);
  result.set(vec3.min(new Float64Array(3), a, b), 9);
  result.set(vec3.max(new Float32Array(3), b, a), 12);
  result.set(vec3.lerp(new Float32Array(3), a, b, .25), 15);
  result.set(vec3.scaleAndAdd(a, a, b, .125), 18);
  result.set(vec3.copy(new Float64Array(3), b), 21);
  result.set(vec3.set(new Float32Array(3), input[0], input[1], input[2]), 24);
  const xy = new Float32Array(input.slice(0, 2));
  result.set(vec2.normalize(xy, xy), 27);
  result[29] = vec3.len(b);
  result[30] = vec3.dist(a, b);
  const ordinary: number[] = [input[3], input[4], input[5]];
  vec3.normalize(ordinary, ordinary);
  for (let i = 0; i < 3; i++) result[31 + i] = ordinary[i];
  result.set(vec3.scale(new Float64Array(3), b, .75), 34);
  return new Uint8Array(result.buffer);
}
