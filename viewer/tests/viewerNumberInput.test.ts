import { describe, expect, it } from 'vitest';
import { numberFromDrag } from '../src/components/ui/numberPrecision';

describe('numeric input dragging', () => {
  it('adjusts relative to the initial value in either direction', () => {
    expect(numberFromDrag(1, 8, .1)).toBe(1.2);
    expect(numberFromDrag(1, -8, .1)).toBe(.8);
    expect(numberFromDrag(1, 0, .1)).toBe(1);
  });

  it('allows repeat values beyond the old slider range, including negative and zero values', () => {
    expect(numberFromDrag(20, 40, .1)).toBe(21);
    expect(numberFromDrag(-20, -40, .1)).toBe(-21);
    expect(numberFromDrag(.1, -4, .1)).toBe(0);
  });

  it('respects bounds when dragging a ranged control', () => {
    expect(numberFromDrag(95, 80, 1, { min: 10, max: 100 })).toBe(100);
    expect(numberFromDrag(15, -80, 1, { min: 10, max: 100 })).toBe(10);
  });

  it('preserves small steps without floating point display artifacts', () => {
    expect(numberFromDrag(.000001, 4, .0000001)).toBe(.0000011);
    expect(numberFromDrag(.2, 4, .1)).toBe(.3);
  });

  it('uses relative scaling for logarithmic controls while keeping their precision', () => {
    expect(numberFromDrag(128, 40, 1, { log: true })).toBe(256);
    expect(numberFromDrag(128, -40, 1, { log: true })).toBe(64);
    expect(numberFromDrag(2.8, 40, .1, { log: true })).toBe(5.6);
  });
});
