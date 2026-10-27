import type { ModelPreset } from './presets';
import presets from './model-presets.json';

export const RESEARCH_SCENES_SOURCE = 'https://github.com/ErfanMo77/gltf-research-scenes';
export const RESEARCH_MODEL_PRESETS = presets.filter((preset) => 'category' in preset && preset.category === 'research') as ModelPreset[];
