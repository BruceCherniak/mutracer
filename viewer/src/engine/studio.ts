import {studioPanel, studioAmbientValue} from '../../../src/util/studioLighting';
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


/**
 * Builds the rect lights of a preset around `sphere`. `intensity` scales their
 * brightness. `size` changes shadow softness while preserving irradiance at
 * the model center. Low panels are raised toward clearance above `groundY`.
 */
export function buildStudioRig(
  preset: StudioPreset, sphere: THREE.Sphere, intensity: number, rotationDegrees: number, size = 1, groundY = 0
): THREE.RectAreaLight[] {
  const basis = new THREE.Matrix4();
  return preset.lights.map((spec) => {
    const p = studioPanel(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius,
      spec.azimuth, spec.elevation, spec.distance, spec.width, spec.height, spec.power,
      intensity, rotationDegrees, size, groundY);
    const light = new THREE.RectAreaLight(0xffffff, p[2], p[0], p[1]);
    light.name = spec.name;
    light.position.set(p[12], p[13], p[14]);
    basis.makeBasis(new THREE.Vector3(p[3], p[4], p[5]),
      new THREE.Vector3(p[6], p[7], p[8]), new THREE.Vector3(p[9], p[10], p[11]));
    light.quaternion.setFromRotationMatrix(basis);
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
    const value = studioAmbientValue(row, height);
    for (let col = 0; col < width; col++) {
      const o = (row * width + col) * 4;
      data[o] = data[o + 1] = data[o + 2] = value;
      data[o + 3] = 1;
    }
  }
  return { data, width, height };
}
