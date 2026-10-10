import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STUDIO_PRESETS, buildStudioRig } from '../../viewer/src/engine/studio';

const facing = (light: THREE.RectAreaLight) => new THREE.Vector3(0, 0, -1).applyQuaternion(light.quaternion);

describe('viewer studio rigs', () => {
  it('has eight presets with unique ids', () => {
    expect(STUDIO_PRESETS).toHaveLength(8);
    expect(new Set(STUDIO_PRESETS.map((p) => p.id)).size).toBe(8);
  });

  it.each(STUDIO_PRESETS.map((p) => [p.id, p] as const))('%s aims every panel at the model and keeps it above ground', (_, preset) => {
    const sphere = new THREE.Sphere(new THREE.Vector3(0.3, 0.4, -0.2), 0.5);
    for (const light of buildStudioRig(preset, sphere, 1, 30)) {
      const toCenter = sphere.center.clone().sub(light.position).normalize();
      expect(facing(light).dot(toCenter)).toBeCloseTo(1, 5);
      // Panels do not roll: their width stays horizontal.
      expect(new THREE.Vector3(1, 0, 0).applyQuaternion(light.quaternion).y).toBeCloseTo(0, 6);
      const halfHeight = Math.abs(new THREE.Vector3(0, 1, 0).applyQuaternion(light.quaternion).y) * light.height / 2;
      expect(light.position.y - halfHeight).toBeGreaterThan(0);
      expect(light.intensity).toBeGreaterThan(0);
    }
  });

  it('scales placement with the model and keeps radiance scale-invariant', () => {
    const preset = STUDIO_PRESETS[0];
    const small = buildStudioRig(preset, new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1), 1, 0);
    const large = buildStudioRig(preset, new THREE.Sphere(new THREE.Vector3(0, 10, 0), 10), 1, 0);
    small.forEach((light, i) => {
      expect(large[i].width).toBeCloseTo(light.width * 10);
      expect(large[i].position.toArray()).toEqual(light.position.toArray().map((v) => expect.closeTo(v * 10, 5)));
      expect(large[i].intensity).toBeCloseTo(light.intensity);
    });
  });

  it('keeps the photographic ratio between key and fill', () => {
    const [key, fill] = buildStudioRig(STUDIO_PRESETS[0], new THREE.Sphere(new THREE.Vector3(), 1), 1, 0);
    // Irradiance at the center is approximately L · A / d².
    const irradiance = (light: THREE.RectAreaLight) => light.intensity * light.width * light.height / light.position.lengthSq();
    expect(irradiance(key) / irradiance(fill)).toBeCloseTo(4, 5);
  });

  it('keeps exposure when panels are resized', () => {
    const sphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 1);
    const base = buildStudioRig(STUDIO_PRESETS[0], sphere, 1, 0);
    const soft = buildStudioRig(STUDIO_PRESETS[0], sphere, 1, 0, 2);
    soft.forEach((light, i) => {
      expect(light.width).toBeCloseTo(base[i].width * 2);
      expect(light.intensity * light.width * light.height).toBeCloseTo(base[i].intensity * base[i].width * base[i].height);
    });
  });
});
