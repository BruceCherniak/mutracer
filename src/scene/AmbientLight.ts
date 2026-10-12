import type { ColorRGB } from '../types.js';

/** Uniform environment radiance. */
export default class AmbientLight {
  /** Light discriminator. */
  readonly type = 'AmbientLight' as const;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Uniform radiance multiplier. Default `1`. */
  intensity: number = 1;

  /** Creates a light; omitted options retain the field defaults. */
  constructor(params: {
    /** Linear RGB color. Default `[1, 1, 1]`. */
    color?: ColorRGB;
    /** Uniform radiance multiplier. Default `1`. */
    intensity?: number;
  } = {}) {
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
  }
}
