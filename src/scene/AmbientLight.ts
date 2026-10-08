import { ColorRGB } from '../types';

/** Uniform light from every direction, added to the environment lighting. */
export default class AmbientLight {
  readonly type = 'AmbientLight' as const;

  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB;
  /** Radiance is `color * intensity`. Default `1`. */
  intensity: number;
  constructor(color: ColorRGB, intensity?: number) {
    this.color = color || [1, 1, 1];
    this.intensity = intensity == null ? 1 : intensity;
  }
}
