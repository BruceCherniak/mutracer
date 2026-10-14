import { describe, expect, it } from 'vitest';
import { MIN_PREVIEW_SCALE, nextPreviewScale } from '../../src/renderer/util';

describe('nextPreviewScale', () => {
  it('scales resolution by the square root of the time ratio', () => {
    // Four times over budget halves the scale.
    expect(nextPreviewScale(1, 80, 20, 1)).toBe(0.5);
    // Four times under budget doubles it, up to the configured maximum.
    expect(nextPreviewScale(0.25, 5, 20, 1)).toBe(0.5);
    expect(nextPreviewScale(0.5, 1, 20, 0.75)).toBe(0.75);
  });

  it('uses 1/16 steps and stays within the allowed range', () => {
    expect(nextPreviewScale(1, 36, 20, 1)).toBe(0.75);
    expect(nextPreviewScale(0.5, 10_000, 20, 1)).toBe(MIN_PREVIEW_SCALE);
  });

  it('keeps the current scale for small changes', () => {
    expect(nextPreviewScale(0.5, 22, 20, 1)).toBe(0.5);
    // Hysteresis is measured against the current scale, not the measured one.
    expect(nextPreviewScale(0.5, 20, 20, 1, 0.5625)).toBe(0.5625);
  });
  it('adapts severe slowdowns below quarter scale while keeping custom bounds', () => {
    expect(nextPreviewScale(.25, 80, 20, .5)).toBe(.125);
    expect(nextPreviewScale(.125, 80, 20, .5)).toBe(.125);
    expect(nextPreviewScale(.25, 10000, 20, .5, .25, .125)).toBe(.125);
    expect(nextPreviewScale(.0625, 12, 20, .5, .0625, .0625)).toBe(.078125);
  });
});
