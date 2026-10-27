import {
  JNLM_WORKGROUP_SIZE, jnlmGuideWGSL, jnlmVarianceWGSL, createJNLMLoadColorWGSL,
  createJNLMFilterWGSL, jnlmEncodeWGSL, packJNLMParameters
} from '../../src/renderer/wgsl/jnlm.compute.js';
import {nativeDisplayEffectsShader} from './display-shader.js';

// The native host asks the same generator as WebGPU for its current shape.
// No checked-in shader copy or host-side source rewriting is involved.
export function jnlmParameters(width: number, height: number, strength: number,
  searchRadius: number, patchRadius: number, albedoBandwidth: number,
  normalBandwidth: number, iterations: number): Uint8Array {
  const shape = {searchRadius, patchRadius, albedoBandwidth, normalBandwidth, iterations};
  const parameters: number[][] = [];
  for (let i = 0; i < iterations; i++) {
    parameters.push(Array.from(new Uint32Array(packJNLMParameters(width, height, strength, i))));
  }
  return new TextEncoder().encode(JSON.stringify({
    guide: jnlmGuideWGSL,
    variance: jnlmVarianceWGSL,
    prepare: createJNLMLoadColorWGSL('buffers'),
    filter: createJNLMFilterWGSL(shape, 'buffers'),
    encode: jnlmEncodeWGSL,
    composed: nativeDisplayEffectsShader(false, 'linear'),
    albedo: nativeDisplayEffectsShader(false, 'albedo'),
    workgroupSize: JNLM_WORKGROUP_SIZE,
    parameters
  }));
}
