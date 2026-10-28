import type { ModelPreset } from './presets';
import presets from './model-presets.json';

// Shared with the standalone viewer; collection assets are downloaded on demand.
export const PUBLIC_MODEL_PRESETS = presets.filter((preset) => !('category' in preset)) as ModelPreset[];
