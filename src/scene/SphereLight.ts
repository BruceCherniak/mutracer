import type { Vec3 } from '../types.js';
import { ColorRGB } from '../types.js';

/** Spherical area light. */
export default class SphereLight {
  /** Light discriminator; always `SphereLight`. */
  readonly type = 'SphereLight' as const;

  /** World-space center. */
  position: Vec3;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB;
  /** Emitted radiance is `color * intensity`. Default `1`. */
  intensity: number;
  /** Sphere radius in scene units. `0` makes a point light. Default `1`. */
  radius: number;

  constructor(
    position: Vec3,
    color?: ColorRGB,
    intensity?: number,
    radius?: number
  ) {
    this.position = position || [1, 1, 1];
    this.color = color || [1, 1, 1];
    this.intensity = intensity == null ? 1 : intensity;
    this.radius = radius ?? 1;
    if (!(this.radius >= 0)) {
      throw new Error('SphereLight radius must be non-negative');
    }
  }


}
