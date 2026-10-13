import { MATERIAL_TEXTURE_FEATURE_BITS } from './materialTextureSlots.js';

/** Scene data that changes without changing resource layouts or algorithms. */
export const WGPU_SCENE_FEATURE_BITS: Record<string, number> = {
  USE_ENVMAP: 1,
  ...MATERIAL_TEXTURE_FEATURE_BITS,
  HAS_THIN_FILM: 2 ** 10,
  HAS_COAT: 2 ** 11,
  HAS_FUZZ: 2 ** 12,
  HAS_SUBSURFACE: 2 ** 13,
  HAS_SHADOW_CATCHER: 2 ** 14
};

export function wgpuSceneFeatureFlags(constants: Record<string, boolean | number>) {
  let flags = 0;
  for (const [name, bit] of Object.entries(WGPU_SCENE_FEATURE_BITS)) {
    if (constants[name]) flags |= bit;
  }
  return flags;
}
