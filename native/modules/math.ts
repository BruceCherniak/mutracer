import { mat3, mat4, vec2, vec3 } from '../../src/math.js';

function save(target: Float32Array, offset: number, value: Float32Array): number {
  target.set(value, offset); return offset + value.length;
}

/** Whole retained numeric module exercised through a single byte entry. */
export function mathParameters(bytes: Uint8Array): Uint8Array {
  const input = new Float32Array(bytes.buffer, bytes.byteOffset, 3);
  const a = new Float32Array([input[0], input[1], input[2]]);
  const b = new Float32Array([.3, -.7, 1.2]);
  const matrix = mat4.fromScaling(mat4.create(), new Float32Array([2, 3, 4]));
  mat4.translate(matrix, matrix, a);
  const result = new Float32Array(512);
  let offset = 0;
  offset = save(result, offset, mat3.create());
  offset = save(result, offset, mat3.fromMat4(mat3.create(), matrix));
  offset = save(result, offset, mat3.normalFromMat4(mat3.create(), matrix)!);
  offset = save(result, offset, mat4.create());
  offset = save(result, offset, mat4.copy(mat4.create(), matrix));
  offset = save(result, offset, mat4.invert(mat4.create(), matrix)!);
  offset = save(result, offset, mat4.identity(mat4.create()));
  offset = save(result, offset, mat4.lookAt(mat4.create(), a, b, new Float32Array([0, 1, 0])));
  offset = save(result, offset, mat4.targetTo(mat4.create(), a, b, new Float32Array([0, 1, 0])));
  offset = save(result, offset, mat4.getScaling(new Float32Array(3), matrix));
  offset = save(result, offset, mat4.multiply(mat4.create(), matrix, matrix));
  offset = save(result, offset, mat4.mul(mat4.create(), matrix, matrix));
  offset = save(result, offset, mat4.ortho(mat4.create(), -1, 1, -2, 2, .1, 100));
  offset = save(result, offset, mat4.orthoNO(mat4.create(), -1, 1, -2, 2, .1, 100));
  offset = save(result, offset, mat4.perspective(mat4.create(), .7, 1.5, .1, 100));
  offset = save(result, offset, mat4.perspectiveNO(mat4.create(), .7, 1.5, .1, Infinity));
  offset = save(result, offset, mat4.scale(mat4.create(), matrix, a));
  offset = save(result, offset, mat4.rotateZ(mat4.create(), matrix, .37));
  offset = save(result, offset, mat4.fromScaling(mat4.create(), a));
  offset = save(result, offset, mat4.translate(mat4.create(), matrix, b));
  offset = save(result, offset, vec2.create());
  offset = save(result, offset, vec2.copy(new Float32Array(2), a));
  offset = save(result, offset, vec2.set(new Float32Array(2), input[0], input[1]));
  offset = save(result, offset, vec2.min(new Float32Array(2), a, b));
  offset = save(result, offset, vec2.max(new Float32Array(2), a, b));
  offset = save(result, offset, vec2.normalize(new Float32Array(2), a));
  offset = save(result, offset, vec2.scale(new Float32Array(2), a, .7));
  offset = save(result, offset, vec2.subtract(new Float32Array(2), a, b));
  offset = save(result, offset, vec2.sub(new Float32Array(2), a, b));
  offset = save(result, offset, new Float32Array([vec2.length(a)]));
  offset = save(result, offset, vec3.create());
  offset = save(result, offset, vec3.copy(new Float32Array(3), a));
  offset = save(result, offset, vec3.set(new Float32Array(3), input[0], input[1], input[2]));
  offset = save(result, offset, vec3.min(new Float32Array(3), a, b));
  offset = save(result, offset, vec3.max(new Float32Array(3), a, b));
  offset = save(result, offset, vec3.normalize(new Float32Array(3), a));
  offset = save(result, offset, vec3.scale(new Float32Array(3), a, .7));
  offset = save(result, offset, vec3.subtract(new Float32Array(3), a, b));
  offset = save(result, offset, vec3.sub(new Float32Array(3), a, b));
  offset = save(result, offset, new Float32Array([vec3.length(a)]));
  offset = save(result, offset, vec3.clone(a));
  offset = save(result, offset, vec3.fromValues(input[0], input[1], input[2]));
  offset = save(result, offset, vec3.cross(vec3.create(), a, b));
  offset = save(result, offset, vec3.lerp(vec3.create(), a, b, .37));
  offset = save(result, offset, vec3.scaleAndAdd(vec3.create(), a, b, .7));
  offset = save(result, offset, vec3.transformMat3(vec3.create(), a, mat3.create()));
  offset = save(result, offset, vec3.transformMat4(vec3.create(), a, matrix));
  offset = save(result, offset, new Float32Array([vec3.distance(a, b), vec3.dist(a, b), vec2.len(a)]));
  const wide = new Float64Array([input[0], input[1], input[2]]);
  const ordinary = [input[0], input[1], input[2]];
  vec3.scale(wide, wide, .7);
  vec3.normalize(ordinary, ordinary);
  offset = save(result, offset, new Float32Array([wide[0], wide[1], wide[2], ordinary[0], ordinary[1], ordinary[2]]));
  const packed = new Float32Array([1, 2, 3, 9, 4, 5, 6, 8]);
  vec3.forEach(packed, 4, 0, 2, vec3.transformMat4, matrix);
  offset = save(result, offset, packed);
  result[511] = offset;
  return new Uint8Array(result.buffer);
}
