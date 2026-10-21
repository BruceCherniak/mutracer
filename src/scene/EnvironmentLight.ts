import Texture from './Texture.js';
import SceneNode from './SceneNode.js';

/**
 * Image-based lighting from an equirectangular (latitude-longitude) HDR map,
 * for example one loaded with `loadRGBE()`. Importance sampled.
 * `transform` rotates the environment from local to world space (default identity);
 * translation and positive axis scale are ignored.
 */
export default class EnvironmentLight extends SceneNode {
  /** Light discriminator; always `EnvironmentLight`. */
  readonly type = 'EnvironmentLight' as const;
  /** Equirectangular radiance map in linear color. The first row is the zenith (+Y); `flipY` is ignored. */
  map: Texture;
  /** Nonnegative radiance multiplier; zero disables this light. Default `1`. */
  intensity = 1;
  constructor(params: {
    /** Required equirectangular radiance map; no default. */ map: Texture;
    /** Nonnegative radiance multiplier; zero disables this light. Default `1`. */ intensity?: number;
  }) {
    super();
    this.map = params.map;
    this.intensity = params.intensity ?? 1;
  }
}
