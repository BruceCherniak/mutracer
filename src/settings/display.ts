import type Display from '../Display.js';
import type { DisplaySettings } from '../Display.js';
import type { RenderTarget } from '../renderer/renderPipeline.js';
import type { ToneMappingParams } from '../renderer/RenderingPipeline.js';

type Descriptor<K extends keyof DisplaySettings> = {
  key: K; default: Display[K]; kind: 'display'; backends: readonly ('webgpu' | 'webgl')[];
  group: 'toneMapping' | 'bloom' | 'hdr' | 'channel' | 'catcher'; parameter: string;
};
const both = ['webgpu', 'webgl'] as const;
export const displaySchema = {
  toneMapping: {key: 'toneMapping', default: 'agx', kind: 'display', backends: both, group: 'toneMapping', parameter: 'toneMapping'},
  toneMappingExposure: {key: 'toneMappingExposure', default: 1, kind: 'display', backends: both, group: 'toneMapping', parameter: 'exposure'},
  contrast: {key: 'contrast', default: 1, kind: 'display', backends: both, group: 'toneMapping', parameter: 'contrast'},
  saturation: {key: 'saturation', default: 1, kind: 'display', backends: both, group: 'toneMapping', parameter: 'saturation'},
  temperature: {key: 'temperature', default: 0, kind: 'display', backends: both, group: 'toneMapping', parameter: 'temperature'},
  tint: {key: 'tint', default: 0, kind: 'display', backends: both, group: 'toneMapping', parameter: 'tint'},
  vignette: {key: 'vignette', default: 0, kind: 'display', backends: both, group: 'toneMapping', parameter: 'vignette'},
  bloomIntensity: {key: 'bloomIntensity', default: 0, kind: 'display', backends: both, group: 'bloom', parameter: 'intensity'},
  bloomThreshold: {key: 'bloomThreshold', default: 1, kind: 'display', backends: both, group: 'bloom', parameter: 'threshold'},
  bloomRadius: {key: 'bloomRadius', default: .6, kind: 'display', backends: both, group: 'bloom', parameter: 'radius'},
  hdrOutputEnabled: {key: 'hdrOutputEnabled', default: false, kind: 'display', backends: ['webgpu'], group: 'hdr', parameter: 'enabled'},
  channel: {key: 'channel', default: 'final', kind: 'display', backends: both, group: 'channel', parameter: 'channel'},
  shadowCatcherColor: {key: 'shadowCatcherColor', default: [0, 0, 0], kind: 'display', backends: both, group: 'catcher', parameter: 'color'},
  shadowCatcherAlpha: {key: 'shadowCatcherAlpha', default: 1, kind: 'display', backends: both, group: 'catcher', parameter: 'alpha'},
} satisfies {[K in keyof DisplaySettings]-?: Descriptor<K>};
const fields = Object.values(displaySchema);
export function displaySettingsKey(display: Display) { return JSON.stringify(fields.map(field => display[field.key])); }
export function applyDisplaySettings(display: Display, target: RenderTarget) {
  const groups = new Map<string, Record<string, unknown>>();
  for (const field of fields) {
    let values = groups.get(field.group);
    if (!values) groups.set(field.group, values = {});
    values[field.parameter] = display[field.key];
  }
  target.setToneMappingParams(groups.get('toneMapping') as unknown as ToneMappingParams);
  target.setBloomParams(groups.get('bloom') as {intensity: number; threshold: number; radius: number});
  target.setHDROutputEnabled?.(groups.get('hdr')!.enabled as boolean);
  target.setOutput(groups.get('channel')!.channel as Display['channel']);
  target.setShadowCatcherParams(groups.get('catcher')!.color as Display['shadowCatcherColor'], groups.get('catcher')!.alpha as number);
}
