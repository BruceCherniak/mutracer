import type { ColorRGB } from '../types.js';
import SceneNode from './SceneNode.js';
import type IESProfile from './IESProfile.js';

/** Analytic light placed with transform; local -Z is the emission direction and local +X is the IES reference. */
export default class SpotLight extends SceneNode {
  /** Light discriminator. */
  readonly type = 'SpotLight' as const;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB = [1, 1, 1];
  /** Axial intensity in candela. Default `1`. */
  intensity: number = 1;
  /** Emitter radius in scene units; 0 is a point emitter. Default `0.01`. */
  radius: number = 0.01;
  /** Full-intensity cone half-angle in degrees. Default `30`. */
  innerAngle: number = 30;
  /** Cutoff cone half-angle in degrees, at most 180. Default `45`. */
  outerAngle: number = 45;
  /** Optional photometric emission profile. Default `undefined`. */
  iesProfile: IESProfile | undefined = undefined;

  /** Creates a light; omitted options retain the field defaults. */
  constructor(params: {
    /** Linear RGB color. Default `[1, 1, 1]`. */
    color?: ColorRGB;
    /** Axial intensity in candela. Default `1`. */
    intensity?: number;
    /** Emitter radius in scene units; 0 is a point emitter. Default `0.01`. */
    radius?: number;
    /** Full-intensity cone half-angle in degrees. Default `30`. */
    innerAngle?: number;
    /** Cutoff cone half-angle in degrees, at most 180. Default `45`. */
    outerAngle?: number;
    /** Optional photometric emission profile. Default `undefined`. */
    iesProfile?: IESProfile | undefined;
  } = {}) {
    super();
    this.color = params.color ?? [1, 1, 1];
    this.intensity = params.intensity ?? 1;
    this.radius = params.radius ?? 0.01;
    this.innerAngle = params.innerAngle ?? 30;
    this.outerAngle = params.outerAngle ?? 45;
    this.iesProfile = params.iesProfile ?? undefined;
  }
}
