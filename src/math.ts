import {
  mat3 as glMat3,
  mat4 as glMat4,
  vec2 as glVec2,
  vec3 as glVec3
} from 'gl-matrix';
// Keep the namespace-shaped type API used by the public scene classes while
// selecting individual functions so bundles can discard unused gl-matrix code.
export const mat3: any = {
  create: glMat3.create,
  fromMat4: glMat3.fromMat4,
  normalFromMat4: glMat3.normalFromMat4
};
export namespace mat3 {
  export type Mat3Array = Float32Array | number[];
}

export const mat4: any = {
  copy: glMat4.copy,
  create: glMat4.create,
  invert: glMat4.invert,
  lookAt: glMat4.lookAt,
  targetTo: glMat4.targetTo,
  getScaling: glMat4.getScaling,
  mul: glMat4.mul,
  multiply: glMat4.multiply,
  ortho: glMat4.ortho,
  perspective: glMat4.perspective,
  scale: glMat4.scale,
  rotateZ: glMat4.rotateZ,
  fromScaling: glMat4.fromScaling,
  translate: glMat4.translate
};
export namespace mat4 {
  export type Mat4Array = Float32Array | number[];
}

export const vec2: any = {
  copy: glVec2.copy,
  create: glVec2.create,
  len: glVec2.len,
  max: glVec2.max,
  min: glVec2.min,
  normalize: glVec2.normalize,
  scale: glVec2.scale,
  set: glVec2.set,
  sub: glVec2.sub
};
export namespace vec2 {
  export type Vec2Array = Float32Array | number[];
}

export const vec3: any = {
  clone: glVec3.clone,
  copy: glVec3.copy,
  create: glVec3.create,
  cross: glVec3.cross,
  dist: glVec3.dist,
  forEach: glVec3.forEach,
  fromValues: glVec3.fromValues,
  length: glVec3.length,
  lerp: glVec3.lerp,
  max: glVec3.max,
  min: glVec3.min,
  normalize: glVec3.normalize,
  scale: glVec3.scale,
  scaleAndAdd: glVec3.scaleAndAdd,
  set: glVec3.set,
  sub: glVec3.sub,
  transformMat3: glVec3.transformMat3,
  transformMat4: glVec3.transformMat4
};
export namespace vec3 {
  export type Vec3Array = Float32Array | number[];
}

export type Mat4Array = Float32Array | number[];
export type TextureImageSource = any;
export interface TexturePixelSource {
  data: Float32Array | Int32Array | Uint8Array;
  width: number;
  height: number;
}
