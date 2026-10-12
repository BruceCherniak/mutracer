import type { Vec3 } from '../types.js';
import { ColorRGB } from '../types.js';

/**
 * Infinitely distant light, such as the sun. Light arrives from `position`
 * towards the origin; only its direction matters.
 */
export default class DirectionalLight {
  /** Light discriminator; always `DirectionalLight`. */
  readonly type = 'DirectionalLight' as const;

  /** A point on the light's side; the light travels from here towards `[0, 0, 0]`. */
  position: Vec3;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB;
  /** Irradiance on a surface facing the light is `color * intensity`. Default `1`. */
  intensity: number;

  constructor(position: Vec3, color?: ColorRGB, intensity?: number) {
    this.position = position || [1, 1, 1];
    this.color = color || [1, 1, 1];
    this.intensity = intensity ?? 1;
  }
}
