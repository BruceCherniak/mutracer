import type { RenderSettings } from '@meimu/mutracer';
import type { Settings } from '../store';
type DenoiserOptions = NonNullable<RenderSettings['denoiser']>;
export const DENOISER_FIELDS = [
  'denoise', 'denoiseModel', 'denoiseWhileConverging',
  'jnlmStrength', 'jnlmSearchRadius', 'jnlmPatchRadius', 'jnlmAlbedoBandwidth', 'jnlmNormalBandwidth', 'jnlmIterations',
  'oidnModel', 'oidnMaxTileSize'
] as const satisfies readonly (keyof Settings)[];
/** Per-output schedules and networks; WebGL always uses JNLM. */
export function getDenoiserOptions(s: Settings, webgpu: boolean, weightsBaseUrl: string, preview = false): DenoiserOptions | null {
  if (!s.denoise || (preview && !s.denoiseWhileConverging)) return null;
  const schedule = preview ? 'every-sample' : s.denoiseWhileConverging ? 'progressive' : 'converged';
  return !webgpu || s.denoiseModel === 'jnlm' ? {
    schedule, type: 'jnlm', strength: s.jnlmStrength, searchRadius: s.jnlmSearchRadius,
    patchRadius: s.jnlmPatchRadius, albedoBandwidth: s.jnlmAlbedoBandwidth,
    normalBandwidth: s.jnlmNormalBandwidth, iterations: s.jnlmIterations
  } : {schedule, type: 'oidn', model: preview ? 'small' : s.denoiseModel,
    maxTileSize: s.oidnMaxTileSize || undefined, weightsBaseUrl};
}
