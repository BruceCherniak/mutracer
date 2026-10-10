import type { DenoiserOptions } from '@meimu/mutracer';
import type { Settings } from '../store';

export const DENOISER_FIELDS = [
  'denoise', 'denoiseModel', 'denoiseWhileConverging',
  'jnlmStrength', 'jnlmSearchRadius', 'jnlmPatchRadius', 'jnlmAlbedoBandwidth', 'jnlmNormalBandwidth', 'jnlmIterations',
  'oidnModel', 'oidnMaxTileSize'
] as const satisfies readonly (keyof Settings)[];

/** Use only the active denoiser's options; WebGL always uses JNLM. */
export function getDenoiserOptions(s: Settings, webgpu: boolean, weightsBaseUrl: string): DenoiserOptions | false {
  if (!s.denoise) return false;
  const common = {
    whileConverging: s.denoiseWhileConverging
  };
  return !webgpu || s.denoiseModel === 'jnlm' ? {
    ...common,
    type: 'jnlm',
    strength: s.jnlmStrength,
    searchRadius: s.jnlmSearchRadius,
    patchRadius: s.jnlmPatchRadius,
    albedoBandwidth: s.jnlmAlbedoBandwidth,
    normalBandwidth: s.jnlmNormalBandwidth,
    iterations: s.jnlmIterations
  } : {
    ...common,
    type: 'oidn',
    model: s.denoiseModel,
    maxTileSize: s.oidnMaxTileSize || undefined,
    weightsBaseUrl
  };
}
