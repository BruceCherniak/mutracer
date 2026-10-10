import * as THREE from 'three';
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
export const STUDIO_PRESETS: StudioPreset[] = [
  {
    id: 'three-point',
    name: 'Three-point',
    tag: 'Key, fill, rim · 4:1',
    lights: [
      { name: 'Key', azimuth: -40, elevation: 30, distance: 3, width: 1.4, height: 1.8, power: 1 },
      { name: 'Fill', azimuth: 50, elevation: 10, distance: 3.5, width: 1.8, height: 1.8, power: 0.25 },
      { name: 'Rim', azimuth: 155, elevation: 35, distance: 3, width: 0.5, height: 2, power: 0.8 }
    ]
  },
  {
    id: 'rembrandt',
    name: 'Rembrandt',
    tag: 'High 45° key · 8:1',
    lights: [
      { name: 'Key', azimuth: -45, elevation: 45, distance: 2.8, width: 1.2, height: 1.2, power: 1.2 },
      { name: 'Fill', azimuth: 40, elevation: 0, distance: 3.5, width: 1.6, height: 2, power: 0.15 }
    ]
  },
  {
    id: 'butterfly',
    name: 'Butterfly',
    tag: 'Key above the lens',
    lights: [
      { name: 'Key', azimuth: 0, elevation: 50, distance: 3, width: 1.4, height: 1, power: 1.1 },
      { name: 'Hair', azimuth: 180, elevation: 55, distance: 3, width: 1.6, height: 0.4, power: 0.4 }
    ]
  },
  {
    id: 'clamshell',
    name: 'Clamshell',
    tag: 'Top and bottom fill',
    lights: [
      { name: 'Top', azimuth: 0, elevation: 40, distance: 2.8, width: 2, height: 0.9, power: 1 },
      { name: 'Bottom', azimuth: 0, elevation: -12, distance: 2.6, width: 2, height: 0.6, power: 0.4 },
      { name: 'Kicker left', azimuth: -145, elevation: 15, distance: 3, width: 0.4, height: 2.2, power: 0.35 },
      { name: 'Kicker right', azimuth: 145, elevation: 15, distance: 3, width: 0.4, height: 2.2, power: 0.35 }
    ]
  },
  {
    id: 'split',
    name: 'Split',
    tag: 'One key at 90°',
    lights: [
      { name: 'Key', azimuth: -90, elevation: 10, distance: 2.8, width: 1, height: 2.2, power: 1.2 }
    ]
  },
  {
    id: 'rim',
    name: 'Rim',
    tag: 'Twin strips behind',
    lights: [
      { name: 'Strip left', azimuth: -130, elevation: 15, distance: 3, width: 0.45, height: 2.6, power: 1 },
      { name: 'Strip right', azimuth: 130, elevation: 15, distance: 3, width: 0.45, height: 2.6, power: 1 },
      { name: 'Top', azimuth: 0, elevation: 75, distance: 3, width: 1.5, height: 1.5, power: 0.15 }
    ]
  },
  {
    id: 'high-key',
    name: 'High key',
    tag: 'Soft, low contrast',
    lights: [
      { name: 'Front', azimuth: 0, elevation: 20, distance: 3.5, width: 3, height: 2.4, power: 0.7 },
      { name: 'Left', azimuth: -70, elevation: 25, distance: 3.5, width: 2.4, height: 2.4, power: 0.5 },
      { name: 'Right', azimuth: 70, elevation: 25, distance: 3.5, width: 2.4, height: 2.4, power: 0.5 },
      { name: 'Top', azimuth: 0, elevation: 85, distance: 3.5, width: 3, height: 3, power: 0.5 }
    ]
  },
  {
    id: 'tabletop',
    name: 'Tabletop',
    tag: 'Overhead and strips',
    lights: [
      { name: 'Overhead', azimuth: 0, elevation: 80, distance: 3, width: 3, height: 2, power: 1 },
      { name: 'Strip left', azimuth: -75, elevation: 10, distance: 3, width: 0.5, height: 2.4, power: 0.45 },
      { name: 'Strip right', azimuth: 75, elevation: 10, distance: 3, width: 0.5, height: 2.4, power: 0.45 },
      { name: 'Back', azimuth: 180, elevation: 30, distance: 3, width: 1.6, height: 0.6, power: 0.3 }
    ]
  }
];

export const findStudioPreset = (id: string) => STUDIO_PRESETS.find((p) => p.id === id) ?? STUDIO_PRESETS[0];

const DEG = Math.PI / 180;
const KEY_RADIANCE = 2;

/**
 * Builds the rect lights of a preset around `sphere`. At `intensity` 1 a
 * power-1 key gives the irradiance of a uniform environment of radiance
 * `KEY_RADIANCE`, which exposes like the studio HDRIs under AgX at exposure 1.
 * Lights never dip below `groundY`.
 */
export function buildStudioRig(
  preset: StudioPreset, sphere: THREE.Sphere, intensity: number, rotationDegrees: number, groundY = 0
): THREE.RectAreaLight[] {
  const r = Math.max(sphere.radius, 1e-3);
  const xAxis = new THREE.Vector3();
  const yAxis = new THREE.Vector3();
  const zAxis = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  return preset.lights.map((spec) => {
    const azimuth = (spec.azimuth + rotationDegrees) * DEG;
    const distance = spec.distance * r;
    const width = spec.width * r;
    const height = spec.height * r;
    // A panel subtending A / d² of solid angle with radiance L gives roughly
    // irradiance L A / d²; a uniform environment of radiance L gives π L.
    const radiance = (Math.PI * KEY_RADIANCE * intensity * spec.power * spec.distance ** 2) / (spec.width * spec.height);
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
