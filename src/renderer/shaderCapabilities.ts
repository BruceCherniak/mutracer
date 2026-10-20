import {wgpuSceneFeatureFlags} from './WGPUSceneFeatures.js';

export const MATERIAL_SHADER_CAPABILITIES = {transmission: 1, metal: 2} as const;
export const LIGHT_SHADER_CAPABILITIES = {
  SphereLight: 1, RectLight: 2, SpotLight: 4, DirectionalLight: 8, emissive: 16
} as const;
export const ALL_MATERIAL_SHADER_CAPABILITIES = 3;
export const ALL_LIGHT_SHADER_CAPABILITIES = 31;

export function lightShaderCapabilities(types: readonly string[], emissiveCount: number) {
  let mask = emissiveCount > 0 ? LIGHT_SHADER_CAPABILITIES.emissive : 0;
  for (const type of types) {
    switch (type) {
      case 'SphereLight': mask |= LIGHT_SHADER_CAPABILITIES.SphereLight; break;
      case 'RectLight': mask |= LIGHT_SHADER_CAPABILITIES.RectLight; break;
      case 'SpotLight': mask |= LIGHT_SHADER_CAPABILITIES.SpotLight; break;
      case 'DirectionalLight': mask |= LIGHT_SHADER_CAPABILITIES.DirectionalLight; break;
    }
  }
  return mask;
}

export function updateSceneShaderCapabilities(constants: Record<string, boolean | number>) {
  constants.SCENE_CAPABILITIES = wgpuSceneFeatureFlags(constants);
}
