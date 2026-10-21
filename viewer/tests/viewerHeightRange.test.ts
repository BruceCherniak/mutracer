import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { displacementHeightRange } from '../src/engine/displacementHeightRange';
import { decimalPlacesForStep } from '../src/components/ui/numberPrecision';

describe('displacement height slider range', () => {
  it.each([.001, 1, 1000])('scales range and precision with local geometry size %s', (scale) => {
    const geometry = new THREE.BoxGeometry(2 * scale, 4 * scale, scale);
    const range = displacementHeightRange(geometry);
    expect(range.min).toBe(0);
    expect(range.max).toBeCloseTo(.4 * scale, 8);
    expect(range.step).toBeCloseTo(.0001 * scale, 12);
    const decimals = decimalPlacesForStep(range.step);
    // One keyboard increment must remain distinct from zero after display rounding.
    expect(Number(range.step.toFixed(decimals))).toBe(range.step);
  });

  it('uses local dimensions independently of object scale and translation', () => {
    const geometry = new THREE.BoxGeometry(2, 4, 1);
    const mesh = new THREE.Mesh(geometry);
    const before = displacementHeightRange(geometry);
    mesh.scale.set(100, 200, 300); mesh.position.set(1000, 2000, 3000); mesh.updateMatrixWorld();
    expect(displacementHeightRange(mesh.geometry)).toEqual(before);
    geometry.translate(100, 200, 300);
    expect(displacementHeightRange(geometry)).toEqual(before);
  });

  it('provides a finite range for missing, empty and zero-sized geometry', () => {
    for (const geometry of [undefined, new THREE.BufferGeometry(), new THREE.BoxGeometry(0, 0, 0)]) {
      expect(displacementHeightRange(geometry)).toEqual({ min: 0, max: 1, step: .001 });
    }
  });
});

it.each([[1, 0], [.1, 1], [.001, 3], [.25, 2], [1e-7, 7], [2.5e-7, 8], [2.5e3, 0]])(
  'preserves precision for step %s', (step, decimals) => {
    expect(decimalPlacesForStep(step)).toBe(decimals);
  }
);
