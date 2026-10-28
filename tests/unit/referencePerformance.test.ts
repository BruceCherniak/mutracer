import {expect, it} from 'vitest';
import {comparison} from '../../scripts/reference-performance.mjs';

function result(cpu: number, heap = 1000) {
  return comparison(['webgpu', 'webgl'].flatMap(backend => [
    {backend, version: 'reference', activeFrameCPUms: .2, liveHeapBytes: 1000},
    {backend, version: 'current', activeFrameCPUms: cpu, liveHeapBytes: heap}
  ]));
}
it('requires both CPU thresholds but only the relative heap threshold', () => {
  expect(result(.211).every(row => !row.regression)).toBe(true);
  expect(result(.251).every(row => row.regression)).toBe(true);
  expect(result(.2, 1031).every(row => row.regression)).toBe(true);
  expect(result(.2, 1030).every(row => !row.regression)).toBe(true);
  const slowFrames = ['webgpu', 'webgl'].flatMap(backend => [
    {backend, version: 'reference', activeFrameCPUms: 10, liveHeapBytes: 1000},
    {backend, version: 'current', activeFrameCPUms: 10.1, liveHeapBytes: 1000}
  ]);
  expect(comparison(slowFrames).every(row => !row.regression)).toBe(true);
});
