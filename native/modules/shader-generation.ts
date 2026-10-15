import rayTraceCompute from '../../src/renderer/wgsl/rayTrace.compute.js';
import { getOpenPbrEnergyLutData } from '../../src/renderer/openPbrEnergyLut.js';

/** Generates the original megakernel from runtime feature flags and BLAS layouts. */
export function shaderParameters(bytes: Uint8Array): Uint8Array {
  const input = new Uint32Array(bytes.buffer, bytes.byteOffset, 2);
  const flags = input[0];
  if (flags & 32) return new Uint8Array(getOpenPbrEnergyLutData().buffer);
  return new TextEncoder().encode(rayTraceCompute({
    hasDisplacement: !!(flags & 1),
    hasAnisotropyDirections: !!(flags & 2),
    hasCoatNormals: !!(flags & 4),
    hasAlpha: !!(flags & 8),
    hasSceneAlpha: !!(flags & 16),
    blasLayoutMask: input[1]
  }));
}
