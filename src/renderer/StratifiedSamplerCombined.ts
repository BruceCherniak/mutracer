/*
Stratified Sampling
http://www.pbr-book.org/3ed-2018/Sampling_and_Reconstruction/Stratified_Sampling.html

It is computationally unfeasible to compute stratified sampling for large dimensions (>2)
Instead, we can compute stratified sampling for lower dimensional patterns that sum to the high dimension
e.g. instead of sampling a 6D domain, we sample a 2D + 2D + 2D domain.
This reaps many benefits of stratification while still allowing for small strata sizes.
*/

// @ts-ignore
import seedrandom from 'seedrandom';
import { makeStratifiedSampler, StratifiedSampler } from './StratifiedSampler';

export function makeStratifiedSamplerCombined(
  strataCount: number,
  listOfDimensions: number[],
  seed: number | string = 0
): StratifiedSampler {
  const strataObjs: ReturnType<typeof makeStratifiedSampler>[] = [];
  // Keep one deterministic random stream alive for the whole sequence. The
  // caller advances this sampler once per accumulated sample, which is what
  // makes every N^D-cell pattern stratified across frames.
  const rand = seedrandom(`claypt_${seed}`);

  listOfDimensions.forEach((dim) => {
    strataObjs.push(makeStratifiedSampler(strataCount, dim, rand));
  });

  const combined: number[] = [];

  function next() {
    let i = 0;

    for (const strata of strataObjs) {
      const nums = strata.next();

      for (const num of nums) {
        combined[i++] = num;
      }
    }

    return combined;
  }

  function restart() {
    for (const strata of strataObjs) {
      strata.restart();
    }
  }

  return {
    next,
    restart,
    strataCount
  };
}
