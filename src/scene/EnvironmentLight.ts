import EnvironmentLightState from './EnvironmentLightState.js';
import type Texture from './Texture.js';

/**
 * Image-based lighting from an equirectangular (latitude-longitude) HDR map,
 * for example one loaded with `loadRGBE()`. Importance sampled.
 */
export default class EnvironmentLight extends EnvironmentLightState {
  /** Equirectangular radiance map in linear color. */
  declare map: Texture;
  constructor(params: { /** Required equirectangular radiance map; no default. */ map: Texture }) { super(params); }
}
