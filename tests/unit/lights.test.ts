import { mat4 } from '../../src/math';
import { describe, expect, it } from 'vitest';
import DirectionalLight from '../../src/scene/DirectionalLight';
import RectLight from '../../src/scene/RectLight';
import SphereLight from '../../src/scene/SphereLight';
import { packLightsToBuffer } from '../../src/renderer/lightsUtil';

describe('analytic lights', () => {
  it('computes emitter areas', () => {
    expect(RectLight.getArea(new RectLight([2, 4]))).toBe(8);
    expect(
      SphereLight.getArea(new SphereLight([0, 0, 0], undefined, undefined, 2))
    ).toBeCloseTo(16 * Math.PI);
  });

  it('packs position, emission and type for the renderer', () => {
    const rect = new RectLight([2, 3], [0.5, 1, 0.25], 4);
    mat4.translate(rect.matrixWorld, rect.matrixWorld, [1, 2, 3]);
    const directional = new DirectionalLight([4, 5, 6], [1, 1, 1], 2);
    const buffer = packLightsToBuffer([rect, directional], [-1, -1]);

    expect(Array.from(buffer.slice(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(buffer.slice(4, 7))).toEqual([2, 4, 1]);
    expect(buffer).toHaveLength(40);
  });

  it('packs light-selection PMFs and CDFs for MIS', () => {
    const lights = [
      new DirectionalLight([0, 1, 0]),
      new DirectionalLight([1, 0, 0])
    ];
    const buffer = packLightsToBuffer(
      lights,
      [-1, -1],
      [0.25, 0.75],
      [0.25, 1]
    );

    expect(buffer[3]).toBeCloseTo(0.25);
    expect(buffer[7]).toBeCloseTo(0.25);
    expect(buffer[23]).toBeCloseTo(0.75);
    expect(buffer[27]).toBeCloseTo(1);
  });
});
