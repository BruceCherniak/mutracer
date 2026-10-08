import {
  mat3 as glMat3,
  mat4 as glMat4,
  quat as glQuat,
  vec2 as glVec2,
  vec3 as glVec3
} from 'gl-matrix';
// Keep the namespace-shaped type API used by the public scene classes while
// making the actual math dependency explicit and renderer agnostic.
export const mat3: any = glMat3;
export namespace mat3 {
  export type Mat3Array = Float32Array | number[];
}

export const mat4: any = glMat4;
export namespace mat4 {
  export type Mat4Array = Float32Array | number[];
}

export const quat: any = glQuat;
export namespace quat {
  export type QuatArray = Float32Array | number[];
}

export const vec2: any = glVec2;
export namespace vec2 {
  export type Vec2Array = Float32Array | number[];
}

export const vec3: any = glVec3;
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
