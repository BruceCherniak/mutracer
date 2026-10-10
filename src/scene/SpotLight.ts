import { vec3 } from '../math.js';
import { ColorRGB } from '../types.js';
import IESProfile from './IESProfile.js';

/**
 * Spot light with a spherical emitter, optional IES photometric profile and a
 * smooth falloff between `innerAngle` and `outerAngle` (cone half-angles in
 * degrees).
 */
export default class SpotLight {
  /** Light discriminator; always `SpotLight`. */
  readonly type = 'SpotLight' as const;
  /** World-space position. */
  position: vec3.Vec3Array;
  /** Normalized world-space direction of the cone axis. */
  direction: vec3.Vec3Array;
  /** Linear RGB color. Default `[1, 1, 1]`. */
  color: ColorRGB;
  /** Intensity along the axis in candela (lm/sr), multiplied by `color`. Default `1`. */
  intensity: number;
  /** Emitter radius in scene units. `0` makes a point emitter. Default `0.01`. */
  radius: number;
  /** Full-intensity cone half-angle in degrees. Default `30`. */
  innerAngle: number;
  /** Cutoff cone half-angle in degrees (at most 180). Default `45`. */
  outerAngle: number;
  /** Kept for API compatibility with Three.js lights; the falloff is not truncated by range. */
  range: number;
  /** Optional IES profile that shapes the emission. */
  iesProfile?: IESProfile;
  /** Clockwise profile rotation around the primary axis, in degrees. */
  iesRotation: number;

  constructor(
    position: vec3.Vec3Array,
    direction: vec3.Vec3Array,
    color: ColorRGB = [1, 1, 1],
    intensity = 1,
    radius = 0.01,
    innerAngle = 30,
    outerAngle = 45,
    range = 0,
    iesProfile?: IESProfile,
    iesRotation = 0
  ) {
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    if (!(length > 0)) throw new Error('SpotLight direction must be non-zero');
    if (!(radius >= 0)) {
      throw new Error('SpotLight radius must be non-negative');
    }
    if (
      innerAngle < 0 ||
      outerAngle <= 0 ||
      innerAngle > outerAngle ||
      outerAngle > 180
    ) {
      throw new Error(
        'SpotLight angles must satisfy 0 <= innerAngle <= outerAngle <= 180'
      );
    }
    this.position = position;
    this.direction = [
      direction[0] / length,
      direction[1] / length,
      direction[2] / length
    ];
    this.color = color;
    this.intensity = intensity;
    this.radius = radius;
    this.innerAngle = innerAngle;
    this.outerAngle = outerAngle;
    this.range = range;
    this.iesProfile = iesProfile;
    this.iesRotation = iesRotation;
  }

  /** @internal */
  static getArea(light: SpotLight) {
    return 4 * Math.PI * light.radius ** 2;
  }

  /** @internal */
  static getRadiance(light: SpotLight) {
    // A zero-radius spot is a point emitter. Its stored emission is luminous
    // intensity (cd), and the shader applies inverse-square attenuation.
    if (light.radius === 0) return light.intensity;
    return light.intensity / (Math.PI * light.radius ** 2);
  }

  /** @internal */
  static getShapingFluxFactor(light: SpotLight) {
    const cosConeAngle = Math.cos((light.outerAngle * Math.PI) / 180);
    const softness = Math.min(
      1,
      Math.max(0, 1 - light.innerAngle / light.outerAngle)
    );
    return (1 - cosConeAngle) * (1 - 0.5 * softness) * 0.5;
  }
}
