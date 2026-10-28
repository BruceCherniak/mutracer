import RectLightState from './RectLightState.js';
import type { ColorRGB, Vec2 } from '../types.js';
import type Texture from './Texture.js';

/** Analytic light placed with transform; local -Z is the emission direction and local +X is the IES reference. */
export default class RectLight extends RectLightState {
  /** Emission texture. Default `undefined`. */
  declare texture: Texture | undefined;
  constructor(params: {
    /** Width and height; transform scale is ignored. Default `[1, 1]`. */
    size?: Vec2;
    /** Linear RGB color. Default `[1, 1, 1]`. */
    color?: ColorRGB;
    /** Emitted radiance multiplier. Default `1`. */
    intensity?: number;
    /** Emission texture. Default `undefined`. */
    texture?: Texture | undefined;
    /** Angular spread from 0 (collimated) to 1 (hemisphere). Default `1`. */
    spread?: number;
  } = {}) {
    super(params);
  }
}
