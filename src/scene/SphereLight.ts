import type { ColorRGB } from '../types.js';
import SceneNode from './SceneNode.js';

/** Analytic light placed with transform; local -Z is the emission direction and local +X is the IES reference. */
export default class SphereLight extends SceneNode {
  /** Light discriminator. */
  readonly type = 'SphereLight' as const;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Emitted radiance multiplier. Default `1`. */
  intensity: number = 1;
  /** Emitter radius in scene units; 0 is a point light. Default `1`. */
  radius: number = 1;

  /** Creates a light; omitted options retain the field defaults. */
  constructor(params: {
    /** Linear RGB color. Default `[1, 1, 1]`. */
    color?: ColorRGB;
    /** Emitted radiance multiplier. Default `1`. */
    intensity?: number;
    /** Emitter radius in scene units; 0 is a point light. Default `1`. */
    radius?: number;
  } = {}) {
    super();
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
    this.radius = params.radius ?? 1;
  }
}
