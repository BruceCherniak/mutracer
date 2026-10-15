import type OpenPBRMaterial from '../scene/OpenPBRMaterial.js';
import type { MaterialTextureName } from '../scene/materialTextureNames.js';
import type Texture from '../scene/Texture.js';
import { mergeTexturesFromMaterials as mergeTextureStates } from './materialTextures.js';

// Browser material declarations guarantee every retained texture is a browser Texture.
export function mergeTexturesFromMaterials<T extends MaterialTextureName>(
  materials: OpenPBRMaterial[], textureNames: readonly T[]
) {
  return mergeTextureStates(materials, textureNames) as { textures: Texture[]; indices: Record<T, number[]> };
}
