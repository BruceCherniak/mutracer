import type TextureState from './TextureState.js';

/**
 * Image-based lighting from an equirectangular (latitude-longitude) HDR map,
 * for example one loaded with `loadRGBE()`. Importance sampled.
 */
export default class EnvironmentLightState {
  /** Light discriminator; always `EnvironmentLight`. */
  readonly type = 'EnvironmentLight' as const;
  /** Equirectangular radiance map in linear color. */
  map: TextureState;
  constructor(params: { /** Required equirectangular radiance map; no default. */ map: TextureState }) {
    this.map = params.map;
  }
}
