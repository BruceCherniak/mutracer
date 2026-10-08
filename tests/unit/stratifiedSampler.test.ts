import { describe, expect, it } from 'vitest';
import { makeStratifiedSampler } from '../../src/renderer/StratifiedSampler';
import { makeStratifiedSamplerCombined } from '../../src/renderer/StratifiedSamplerCombined';
import glslRandom from '../../src/renderer/glsl/chunks/random.glsl';
import wgslRandom from '../../src/renderer/wgsl/chunks/random.wgsl';

function makeRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('stratified sampling', () => {
  it('visits every cell once in a complete multidimensional cycle', () => {
    const sampler = makeStratifiedSampler(3, 2, makeRandom());
    const cells = new Set<string>();

    for (let i = 0; i < 9; i++) {
      const sample = [...sampler.next()];
      expect(sample.every((value) => value >= 0 && value < 3)).toBe(true);
      cells.add(`${Math.floor(sample[0])},${Math.floor(sample[1])}`);
    }

    expect(cells.size).toBe(9);
  });

  it('keeps each combined low-dimensional pattern stratified over time', () => {
    const sampler = makeStratifiedSamplerCombined(3, [1, 2], 'test');
    const oneDimensionalCells: number[] = [];
    const twoDimensionalCells = new Set<string>();

    for (let i = 0; i < 9; i++) {
      const sample = [...sampler.next()];
      oneDimensionalCells.push(Math.floor(sample[0]));
      twoDimensionalCells.add(
        `${Math.floor(sample[1])},${Math.floor(sample[2])}`
      );
    }

    for (let offset = 0; offset < 9; offset += 3) {
      expect(new Set(oneDimensionalCells.slice(offset, offset + 3)).size).toBe(3);
    }
    expect(twoDimensionalCells.size).toBe(9);
  });

  it('does not correlate all dimensions in the first samples', () => {
    const sample = makeStratifiedSamplerCombined(6, [2, 2, 2], 0).next();
    const fractionalParts = sample.map((value) => value - Math.floor(value));

    expect(new Set(fractionalParts.map((value) => value.toFixed(8))).size)
      .toBeGreaterThan(1);
  });

  it('wraps over every shader sampling dimension', () => {
    for (const source of [glslRandom.main, wgslRandom]) {
      expect(source).toContain('sampleIndex % SAMPLING_DIMENSIONS');
      expect(source).not.toContain('SAMPLING_DIMENSIONS - 1');
    }
  });
});
