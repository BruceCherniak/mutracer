import { samplingPatternCode, zSobolLog2SPP, zSobolPermutations, zSobolPackedPermutations, sobolD1Steps } from '../../src/renderer/sampling.js';

/** Full sampling module constants and parameter calculation; input is maxSamples:u32. */
export function samplingParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 1);
  const output = new Uint32Array(42);
  output[0] = samplingPatternCode('sobol'); output[1] = zSobolLog2SPP(input[0]);
  output.set(zSobolPermutations, 2); output.set(zSobolPackedPermutations, 26);
  output.set([sobolD1Steps[0][0], sobolD1Steps[0][1], sobolD1Steps[1][0], sobolD1Steps[1][1],
    sobolD1Steps[2][0], sobolD1Steps[2][1], sobolD1Steps[3][0], sobolD1Steps[3][1], sobolD1Steps[4][0], sobolD1Steps[4][1]], 32);
  return new Uint8Array(output.buffer);
}
