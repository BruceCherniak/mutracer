/** Scene data that changes without changing resource layouts or algorithms. */
export const WGPU_SCENE_FEATURE_BITS: Record<string, number> = Object.fromEntries([
  'USE_ENVMAP',
  'USE_DIFFUSE_MAPS', 'USE_ALPHA_MAPS', 'USE_METALLIC_ROUGHNESS_MAPS',
  'USE_ROUGHNESS_MAPS', 'USE_METALNESS_MAPS', 'USE_TRANSMISSION_MAPS',
  'USE_EMISSIVE_MAPS', 'USE_THIN_FILM_MAPS', 'USE_NORMAL_MAPS',
  'HAS_THIN_FILM', 'HAS_COAT', 'HAS_FUZZ', 'HAS_SUBSURFACE',
  'HAS_SHADOW_CATCHER'
].map((name, index) => [name, 2 ** index]));

export function wgpuSceneFeatureFlags(constants: Record<string, boolean | number>) {
  let flags = 0;
  for (const [name, bit] of Object.entries(WGPU_SCENE_FEATURE_BITS)) {
    if (constants[name]) flags |= bit;
  }
  return flags;
}
