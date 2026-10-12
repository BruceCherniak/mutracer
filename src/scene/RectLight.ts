import type { ColorRGB, Vec2 } from '../types.js';
import SceneNode from './SceneNode.js';
import type Texture from './Texture.js';

/** Analytic light placed with transform; local -Z is the emission direction and local +X is the IES reference. */
export default class RectLight extends SceneNode {
  /** Light discriminator. */
  readonly type = 'RectLight' as const;
  /** Width and height; transform scale is ignored. Default `[1, 1]`. */
  size: Vec2 = [1, 1];
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Emitted radiance multiplier. Default `1`. */
  intensity: number = 1;
  /** Emission texture. Default `undefined`. */
  texture: Texture | undefined = undefined;
  /** Angular spread from 0 (collimated) to 1 (hemisphere). Default `1`. */
  spread: number = 1;

  /** Creates a light; omitted options retain the field defaults. */
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
    super();
    this.size = params.size ?? [1, 1];
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
    this.texture = params.texture ?? undefined;
    this.spread = params.spread ?? 1;
  }
}
