import type { Vec2 } from '../types.js';
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
  size: Vec2;
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

  constructor(size?: Vec2, color?: ColorRGB, intensity?: number) {
    super();

    this.size = size || [1, 1];
    this.color = color || [1, 1, 1];
    this.intensity = intensity ?? 1;
  }






}
