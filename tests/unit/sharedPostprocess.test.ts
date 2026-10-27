import {expect, it} from 'vitest';
import {createBloomPlan} from '../../src/renderer/wgsl/bloom.wgsl.js';

it('builds a bloom graph with no feedback or uninitialized reads at every pyramid size', () => {
  for (const levels of [2, 6, 9]) {
    const input = 4 * levels;
    const written = new Set([input]);
    const plan = createBloomPlan(levels);
    for (const [, a, b, target] of plan) {
      expect(written.has(a)).toBe(true);
      expect(written.has(b)).toBe(true);
      expect(a).not.toBe(target); expect(b).not.toBe(target);
      expect(written.has(target)).toBe(false);
      written.add(target);
    }
    // Every intermediate is consumed; the final full-size blend is the output.
    expect(written.size).toBe(4 * levels + 1);
    expect(plan.at(-1)?.[3]).toBe(1 + 3 * levels);
    expect(plan.filter(([kind]) => kind === 2)).toHaveLength(2 * levels);
  }
});
