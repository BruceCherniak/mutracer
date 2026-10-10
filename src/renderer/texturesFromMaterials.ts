// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import OpenPBRMaterial, {
  MaterialTextureName
} from '../scene/OpenPBRMaterial.js';
import Texture from '../scene/Texture.js';

// retrieve textures used by meshes, grouping textures from meshes shared *across all* mesh properties
export function mergeTexturesFromMaterials<T extends MaterialTextureName>(
  materials: OpenPBRMaterial[],
  textureNames: T[]
) {
  const textureMap: {
    textures: Texture[];
    indices: Record<T, number[]>;
  } = {
    textures: [],
    indices: {} as Record<T, number[]>
  };

  for (const name of textureNames) {
    textureMap.indices[name] = texturesFromMaterials(
      materials,
      name,
      textureMap.textures
    );
  }

  return textureMap;
}

function texturesFromMaterials(
  materials: OpenPBRMaterial[],
  textureName: MaterialTextureName,
  textures: Texture[]
) {
  const indices = [];

  for (const material of materials) {
    const isTextureLoaded =
      material[textureName] &&
      material[textureName]!.image &&
      !(
        textureName === 'displacementMap' &&
        material.displacementMode === 'tessellated' &&
        material.displacementBumpStrength <= 0
      );

    if (!isTextureLoaded) {
      indices.push(-1);
    } else {
      let existsIndex = textures.indexOf(material[textureName]!);
      if (existsIndex >= 0) {
        // Reuse existing duplicate texture.
        indices.push(existsIndex);
      } else {
        indices.push(textures.length);
        textures.push(material[textureName]!);
      }
    }
  }

  return indices;
}
