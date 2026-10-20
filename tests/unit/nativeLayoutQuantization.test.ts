import {expect, it} from 'vitest';
import {quantizeDisplacementRange} from '../../native/src/layout.js';

it('rounds displacement range arithmetic to float32 before outward quantization', () => {
  // f32(.2) * 255 in f64 exceeds 51; the native/WASM f32 product is exactly 51.
  expect(quantizeDisplacementRange(.1, .2)).toBe(0x1933);
  expect(quantizeDisplacementRange(.2, .2)).toBe(0x3333);
  expect(quantizeDisplacementRange(-.2, 1.2)).toBe(0x00ff);
  expect(quantizeDisplacementRange(.5, .5000005)).toBe(0x7f7f);
  expect(quantizeDisplacementRange(.5, .500002)).toBe(0x7f80);
});
