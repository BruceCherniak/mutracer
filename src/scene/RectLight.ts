import { mat3, vec2, vec3 } from '../math.js';
import { ColorRGB } from '../types.js';
import SceneNode from './SceneNode.js';
import Texture from './Texture.js';

/**
 * Rectangular area light. The rectangle lies on the local XY plane, centered
 * at the origin, and emits towards local -Z. Position and orient it with
 * `matrixWorld`.
 */
export default class RectLight extends SceneNode {
  /** Light discriminator; always `RectLight`. */
  readonly type = 'RectLight' as const;

  /** Width and height in local units. Default `[1, 1]`. */
  size: vec2.Vec2Array;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB;
  /** Emitted radiance is `color * intensity`. Default `1`. */
  intensity: number;

  /** Optional emission texture multiplied with `color`. */
  texture?: Texture;

  /**
   * Angular spread of the emission, from `0` (a collimated beam) to `1`
   * (a full hemisphere, like a diffuse panel). Default `1`.
   */
  spread = 1;

  constructor(size?: vec2.Vec2Array, color?: ColorRGB, intensity?: number) {
    super();

    this.size = size || [1, 1];
    this.color = color || [1, 1, 1];
    this.intensity = intensity ?? 1;
  }

  /** @internal */
  static getUOrV(light: RectLight, uOrV: 0 | 1) {
    // On the xy plane and point to negative z
    const ret = vec3.fromValues(0, 0, 0);
    // Inverse the v
    ret[uOrV] = (uOrV ? -1 : 1) * light.size[uOrV];
    return vec3.transformMat3(
      ret,
      ret,
      mat3.fromMat4([] as any as mat3.Mat3Array, light.matrixWorld)
    );
  }

  /** @internal */
  static getPosition(light: RectLight) {
    const m = light.matrixWorld;
    return vec3.fromValues(m[12], m[13], m[14]);
  }

  /** @internal */
  static getArea(light: RectLight) {
    return light.size[0] * light.size[1];
  }
}
