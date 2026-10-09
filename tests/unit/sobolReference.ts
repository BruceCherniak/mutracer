import { zSobolPermutations } from '../../src/renderer/sampling';
export function hash(x: number): number {
  x = Math.imul(x ^ x >>> 16, 0x7feb352d);
  x = Math.imul(x ^ x >>> 15, 0x846ca68b);
  return (x ^ x >>> 16) >>> 0;
}
export const seed = (a: number, b: number) => hash(a ^ hash((b + 0x9e3779b9) >>> 0));
export function reverse(x: number) {
  x = (x & 0x55555555) << 1 | x >>> 1 & 0x55555555;
  x = (x & 0x33333333) << 2 | x >>> 2 & 0x33333333;
  x = (x & 0x0f0f0f0f) << 4 | x >>> 4 & 0x0f0f0f0f;
  x = (x & 0x00ff00ff) << 8 | x >>> 8 & 0x00ff00ff;
  return (x << 16 | x >>> 16) >>> 0;
}
export function owen(x: number, s: number) {
  x = (reverse(x) + s) >>> 0;
  for (const c of [0x6c50b47c, 0xb82f1e52, 0xc7afe638, 0x8d22f6e6]) x ^= Math.imul(x, c);
  return reverse(x);
}
export function sobol2D(index: number, s: number) {
  let i = owen(index, seed(s, 0));
  const x = owen(reverse(i), seed(s, 1));
  let y = 0, v = 0x80000000;
  for (; i; i >>>= 1, v ^= v >>> 1) if (i & 1) y ^= v;
  return [x >>> 8, owen(y, seed(s, 2)) >>> 8].map(v => v / 16777216);
}
export function morton2(x: number, y: number, bits = 8) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= (x >>> b & 1) << (2*b) | (y >>> b & 1) << (2*b+1);
  return r >>> 0;
}
// pbrt-v4 GetSampleIndex digit walk; 32-bit/tiled specialization.
export function zIndex(m: number, dim: number, logSPP: number, tileBits = 8) {
  const odd = logSPP & 1, digits = tileBits + ((logSPP + 1) >>> 1);
  let r = 0;
  for (let d = digits - 1; d >= odd; d--) {
    const shift = 2*d - odd;
    const higher = shift < 30 ? m >>> (shift + 2) : 0;
    const p = (hash(higher ^ Math.imul(0x55555555, dim)) >>> 24) % 24;
    r |= (zSobolPermutations[p] >>> (2*(m >>> shift & 3)) & 3) << shift;
  }
  if (odd) r |= (m & 1) ^ (hash(m >>> 1 ^ Math.imul(0x55555555, dim)) & 1);
  return r >>> 0;
}

/** Independent CPU oracle for the public blue-noise-first policy and its A/B variant. */
export function referenceSample(
  pattern: 'sobol' | 'zsobol',
  px: number, py: number, width: number, index: number, dim: number,
  remainingLogSPP: number, sequenceSeed: number, hashed = false
) {
  let s = seed(seed(px + py * width, dim), sequenceSeed);
  if (!hashed && pattern === 'zsobol') {
    const first = index === 0;
    const log = first ? 0 : remainingLogSPP;
    const ordinal = first ? 0 : (index - 1) >>> 0;
    const block = (ordinal >>> log) + (first ? 0 : 1);
    index = zIndex((morton2(px,py) << log | ordinal & ((1 << log)-1)) >>> 0,dim,log);
    s = seed(seed(dim,sequenceSeed),seed(px >>> 8,py >>> 8));
    s = seed(s,block);
  }
  return sobol2D(index,s).map(x => 0.0005 + (1-0.001)*x);
}
