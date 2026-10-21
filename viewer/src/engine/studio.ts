import * as THREE from 'three';
import presets from './studio-presets.json';
import type { EquirectData } from './environment';

/**
 * One softbox, placed on a sphere around the model's bounding-sphere center
 * and aimed at it. Distances and sizes are in model radii, so a rig looks the
 * same on any model scale.
 */
export interface StudioLight {
  name: string;
  /** Degrees around +Y. `0` is the front (+Z), positive toward +X (camera right). */
  azimuth: number;
  /** Degrees above the model center. */
  elevation: number;
  distance: number;
  /** Horizontal and vertical size of the panel. */
  width: number;
  height: number;
  /**
   * Irradiance at the model center relative to a key of `1`. Ratios between
   * lights are the photographic lighting ratios (key 1, fill 0.25 is 4:1).
   */
  power: number;
}

export interface StudioPreset {
  id: string;
  name: string;
  /** Short description shown on the card. */
  tag: string;
  lights: StudioLight[];
}

/**
 * Classic portrait and product layouts. Angles follow the usual studio
 * conventions: key at 30–45° off the camera axis for three-point and
 * Rembrandt, on axis and high for butterfly, 90° for split, behind the subject
 * for rim strips, and a large overhead scrim for tabletop product shots.
 */
export const STUDIO_PRESETS: StudioPreset[] = presets;

export const findStudioPreset = (id: string) => STUDIO_PRESETS.find((p) => p.id === id) ?? STUDIO_PRESETS[0];

const DEG = Math.PI / 180;
const KEY_RADIANCE = 2;

/**
 * Builds the rect lights of a preset around `sphere`. At `intensity` 1 a
 * power-1 key gives the irradiance of a uniform environment of radiance
 * `KEY_RADIANCE`, which exposes like the studio HDRIs under AgX at exposure 1.
 * `size` scales every panel for softer or harder shadows; radiance follows
 * the area so the irradiance, and with it the exposure, stays the same.
 * Lights never dip below `groundY`.
 */
export function buildStudioRig(
  preset: StudioPreset, sphere: THREE.Sphere, intensity: number, rotationDegrees: number, size = 1, groundY = 0
): THREE.RectAreaLight[] {
  const r = Math.max(sphere.radius, 1e-3);
  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  return preset.lights.map((spec) => {
    const azimuth = (spec.azimuth + rotationDegrees) * DEG;
    const distance = spec.distance * r;
    const width = spec.width * size * r;
    const height = spec.height * size * r;
    // A panel subtending A / d² of solid angle with radiance L gives roughly
    // irradiance L A / d²; a uniform environment of radiance L gives π L.
    const radiance = (Math.PI * KEY_RADIANCE * intensity * spec.power * spec.distance ** 2) / (spec.width * spec.height * size * size);
    const light = new THREE.RectAreaLight(0xffffff, radiance, width, height);
    light.name = spec.name;

    const place = (elevation: number) => {
      // Local -Z faces the model; X stays horizontal so panels do not roll,
      // which also keeps an overhead panel well defined.
      zAxis.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
      xAxis.set(Math.cos(azimuth), 0, -Math.sin(azimuth));
      yAxis.crossVectors(zAxis, xAxis);
      light.position.copy(sphere.center).addScaledVector(zAxis, distance);
    };
    let elevation = spec.elevation * DEG;
    place(elevation);
    // Lift low panels until their lower edge clears the ground plane.
    const minY = groundY + 0.02 * r;
    for (let i = 0; i < 16 && light.position.y - Math.abs(yAxis.y) * height / 2 < minY; i++) {
      elevation += 2 * DEG;
      place(elevation);
    }
    light.quaternion.setFromRotationMatrix(basis.makeBasis(xAxis, yAxis, zAxis));
    return light;
  });
}

/**
 * Low ambient fill for studio mode: a dim vertical gradient, brighter overhead
 * like a studio ceiling and darker toward the floor. Unit radiance at the
 * zenith; the caller scales it.
 */
export function createStudioAmbient(width = 64, height = 32): EquirectData {
  const data = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const y = Math.cos(((row + 0.5) / height) * Math.PI);
    const value = y >= 0 ? 0.6 + 0.4 * y : 0.6 + 0.35 * y;
    for (let col = 0; col < width; col++) {
      const o = (row * width + col) * 4;
      data[o] = data[o + 1] = data[o + 2] = value;
      data[o + 3] = 1;
    }
  }
  return { data, width, height };
}
