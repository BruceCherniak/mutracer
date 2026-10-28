import SceneNode from './SceneNode.js';
import type TextureState from './TextureState.js';

/**
 * Image-based lighting from an equirectangular (latitude-longitude) HDR map,
 * for example one loaded with `loadRGBE()`. Importance sampled.
 */
export default class EnvironmentLightState extends SceneNode {
  /** Light discriminator; always `EnvironmentLight`. */
  readonly type = 'EnvironmentLight' as const;
  /** Equirectangular radiance map in linear color. */
  map: TextureState;
  /** Nonnegative radiance multiplier; zero disables this light. Default `1`. */
  intensity = 1;
  constructor(params: { /** Required equirectangular radiance map; no default. */ map: TextureState;
    /** Nonnegative radiance multiplier; zero disables this light. Default `1`. */ intensity?: number }) {
    super();
    this.map = params.map;
    this.intensity = params.intensity ?? 1;
  }
}
