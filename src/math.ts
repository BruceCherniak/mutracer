// Internal numeric modules adapted from gl-matrix; see LICENSES/GlMatrix-MIT.txt.
export * as mat3 from './math/mat3.js';
export * as mat4 from './math/mat4.js';
export * as vec2 from './math/vec2.js';
export * as vec3 from './math/vec3.js';

export type Mat4Array = Float32Array | number[];
export type TextureImageSource = any;
export interface TexturePixelSource {
  data: Float32Array | Int32Array | Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}
