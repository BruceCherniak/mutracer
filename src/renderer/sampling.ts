/** Public sampling choices; independent of the denoiser. */
export type SamplingPattern = 'sobol' | 'zsobol' | 'random';
export function samplingPatternCode(pattern: SamplingPattern) {
  const code = { sobol: 0, zsobol: 1, random: 2 }[pattern];
  if (code === undefined) throw new Error(`Unknown sampling pattern: ${pattern}`);
  return code;
}
/** 256² pixel tiles leave 16 bits for samples in a 32-bit Morton index. */
export function zSobolLog2SPP(maxSamples: number) {
  return Number.isFinite(maxSamples)
    ? Math.min(16, Math.max(0, Math.ceil(Math.log2(Math.max(1, maxSamples)))))
    : 16;
}
// ZSobol digit permutations/order adapted from pbrt-v4 ZSobolSampler,
// https://github.com/mmp/pbrt-v4/blob/master/src/pbrt/samplers.h (Apache-2.0).
export const zSobolPermutations = [
  [0,1,2,3],[0,1,3,2],[0,2,1,3],[0,2,3,1],[0,3,2,1],[0,3,1,2],
  [1,0,2,3],[1,0,3,2],[1,2,0,3],[1,2,3,0],[1,3,2,0],[1,3,0,2],
  [2,1,0,3],[2,1,3,0],[2,0,1,3],[2,0,3,1],[2,3,0,1],[2,3,1,0],
  [3,1,2,0],[3,1,0,2],[3,2,1,0],[3,2,0,1],[3,0,2,1],[3,0,1,2]
].map(p => p.reduce((v, digit, i) => v | digit << (2*i), 0));

/** Four eight-bit permutations per word, avoiding shader array indexing. */
export const zSobolPackedPermutations = Array.from({length: 6}, (_, word) =>
  zSobolPermutations.slice(word * 4, word * 4 + 4).reduce(
    (packed, permutation, byte) => packed | permutation << (byte * 8), 0
  ) >>> 0
);

/** Pascal-mod-2 butterfly for Sobol's second direction-number column. */
export const sobolD1Steps = [
  [1, 0xaaaaaaaa], [2, 0xcccccccc], [4, 0xf0f0f0f0],
  [8, 0xff00ff00], [16, 0xffff0000]
] as const;
