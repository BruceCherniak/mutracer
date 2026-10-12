import type { ColorRGB } from '../types.js';
import SceneNode from './SceneNode.js';

/** Analytic light placed with transform; local -Z is the emission direction and local +X is the IES reference. */
export default class DirectionalLight extends SceneNode {
  /** Light discriminator. */
  readonly type = 'DirectionalLight' as const;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Irradiance on a surface facing the light. Default `1`. */
  intensity: number = 1;

  /** Creates a light; omitted options retain the field defaults. */
  constructor(params: {
    /** Linear RGB color. Default `[1, 1, 1]`. */
    color?: ColorRGB;
    /** Irradiance on a surface facing the light. Default `1`. */
    intensity?: number;
  } = {}) {
    super();
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
  }
}
