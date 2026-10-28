// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import type MaterialState from '../scene/MaterialState.js';
import type { MaterialTextureName } from '../scene/materialTextureNames.js';
import type TextureState from '../scene/TextureState.js';

// retrieve textures used by meshes, grouping textures from meshes shared *across all* mesh properties
export function mergeTexturesFromMaterials<M extends MaterialState, T extends MaterialTextureName>(
  materials: M[],
  textureNames: readonly T[]
): {textures: NonNullable<M[T]>[]; indices: Record<string, number[]>};
export function mergeTexturesFromMaterials(
  materials: MaterialState[], textureNames: readonly MaterialTextureName[]
) {
  const textureMap: {
    textures: TextureState[];
    indices: Record<string, number[]>;
  } = {
    textures: [],
    indices: {} as Record<string, number[]>
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
  materials: MaterialState[],
  textureName: MaterialTextureName,
  textures: TextureState[]
) {
  const indices = [];

  for (const material of materials) {
    const isTextureLoaded =
      material[textureName] &&
      material[textureName]!.image;

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
