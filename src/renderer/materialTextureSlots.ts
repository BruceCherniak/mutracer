import { MATERIAL_TEXTURE_NAMES, type MaterialTextureName } from '../scene/materialTextureNames.js';
export { MATERIAL_TEXTURE_NAMES };
export type { MaterialTextureName };
import { MATERIAL_LAYOUT, materialLayoutFields } from './materialLayout.js';

// Internal slots only. Order is the legacy atlas/index contract. Color spaces
// describe decoding at the sample site; textures share the same stored atlas.
const slots = [
  {
    property: 'map', index: 'diffuseMapIndex',
    target: 'baseColor/alpha/transmissionWeight', channel: 'rgb/a',
    colorSpace: 'srgb', operation: 'custom',
    define: 'NUM_DIFFUSE_MAPS', feature: 'USE_DIFFUSE_MAPS', featureBit: 2 ** 1,
    sampling: 'manual'
  },
  {
    property: 'alphaMap', index: 'alphaMapIndex',
    target: 'alpha', channel: 'g',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_ALPHA_MAPS', feature: 'USE_ALPHA_MAPS', featureBit: 2 ** 2,
    sampling: 'multiply'
  },
  {
    property: 'normalMap', index: 'normalMapIndex',
    target: 'normal', channel: 'rgb',
    colorSpace: 'linear', operation: 'custom',
    define: 'NUM_NORMAL_MAPS', feature: 'USE_NORMAL_MAPS', featureBit: 2 ** 9,
    sampling: 'manual'
  },
  {
    property: 'emissiveMap', index: 'emissiveMapIndex',
    target: 'emission', channel: 'rgb',
    colorSpace: 'srgb', operation: 'custom',
    define: 'NUM_EMISSIVE_MAPS', feature: 'USE_EMISSIVE_MAPS', featureBit: 2 ** 7,
    sampling: 'manual'
  },
  {
    property: 'metallicRoughnessMap', index: 'metallicRoughnessMapIndex',
    target: 'baseMetalness/specularRoughness', channel: 'b/g',
    colorSpace: 'linear', operation: 'custom',
    define: 'NUM_METALLIC_ROUGHNESS_MAPS', feature: 'USE_METALLIC_ROUGHNESS_MAPS', featureBit: 2 ** 3,
    sampling: 'manual'
  },
  {
    property: 'roughnessMap', index: 'roughnessMapIndex',
    target: 'specularRoughness', channel: 'g',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_ROUGHNESS_MAPS', feature: 'USE_ROUGHNESS_MAPS', featureBit: 2 ** 4,
    sampling: 'multiply'
  },
  {
    property: 'metalnessMap', index: 'metalnessMapIndex',
    target: 'baseMetalness', channel: 'b',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_METALNESS_MAPS', feature: 'USE_METALNESS_MAPS', featureBit: 2 ** 5,
    sampling: 'multiply'
  },
  {
    property: 'transmissionMap', index: 'transmissionMapIndex',
    target: 'transmissionWeight', channel: 'r',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_TRANSMISSION_MAPS', feature: 'USE_TRANSMISSION_MAPS', featureBit: 2 ** 6,
    sampling: 'multiply'
  },
  {
    property: 'thinFilmMap', index: 'thinFilmMapIndex',
    target: 'thinFilmThickness', channel: 'per-material',
    colorSpace: 'linear', operation: 'custom',
    define: 'NUM_THIN_FILM_MAPS', feature: 'USE_THIN_FILM_MAPS', featureBit: 2 ** 8,
    sampling: 'manual'
  },
  {
    property: 'displacementMap', index: 'displacementMapIndex',
    target: 'displacement', channel: 'r',
    colorSpace: 'linear', operation: 'custom',
    define: null, feature: null, featureBit: 0,
    sampling: 'manual'
  },
  {
    property: 'coatWeightMap', index: 'coatWeightMapIndex',
    target: 'coatWeight', channel: 'r',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_COAT_WEIGHT_MAPS', feature: 'USE_COAT_WEIGHT_MAPS', featureBit: 2 ** 15,
    sampling: 'multiply'
  },
  {
    property: 'coatRoughnessMap', index: 'coatRoughnessMapIndex',
    target: 'coatRoughness', channel: 'g',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_COAT_ROUGHNESS_MAPS', feature: 'USE_COAT_ROUGHNESS_MAPS', featureBit: 2 ** 16,
    sampling: 'multiply'
  },
  {
    property: 'fuzzColorMap', index: 'fuzzColorMapIndex',
    target: 'fuzzColor', channel: 'rgb',
    colorSpace: 'srgb', operation: 'multiply',
    define: 'NUM_FUZZ_COLOR_MAPS', feature: 'USE_FUZZ_COLOR_MAPS', featureBit: 2 ** 18,
    sampling: 'multiply'
  },
  {
    property: 'fuzzRoughnessMap', index: 'fuzzRoughnessMapIndex',
    target: 'fuzzRoughness', channel: 'a',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_FUZZ_ROUGHNESS_MAPS', feature: 'USE_FUZZ_ROUGHNESS_MAPS', featureBit: 2 ** 19,
    sampling: 'multiply'
  },
  {
    property: 'specularWeightMap', index: 'specularWeightMapIndex',
    target: 'specularWeight', channel: 'a',
    colorSpace: 'linear', operation: 'multiply',
    define: 'NUM_SPECULAR_WEIGHT_MAPS', feature: 'USE_SPECULAR_WEIGHT_MAPS', featureBit: 2 ** 20,
    sampling: 'multiply'
  },
  {
    property: 'specularColorMap', index: 'specularColorMapIndex',
    target: 'specularColor', channel: 'rgb',
    colorSpace: 'srgb', operation: 'multiply',
    define: 'NUM_SPECULAR_COLOR_MAPS', feature: 'USE_SPECULAR_COLOR_MAPS', featureBit: 2 ** 21,
    sampling: 'multiply'
  },
  {
    property: 'anisotropyMap', index: 'anisotropyMapIndex',
    target: 'specularAnisotropy/direction', channel: 'rg/b',
    colorSpace: 'linear', operation: 'custom',
    define: 'NUM_ANISOTROPY_MAPS', feature: 'USE_ANISOTROPY_MAPS', featureBit: 2 ** 22,
    sampling: 'manual'
  },
  {
    property: 'coatNormalMap', index: 'coatNormalMapIndex',
    target: 'coatNormal', channel: 'rgb',
    colorSpace: 'linear', operation: 'custom',
    define: 'NUM_COAT_NORMAL_MAPS', feature: 'USE_COAT_NORMAL_MAPS', featureBit: 2 ** 17,
    sampling: 'manual'
  },
] as const;

// A missing or extra descriptor fails type checking in both directions.
type SlotName = typeof slots[number]['property'];
const textureNamesMatch: [Exclude<MaterialTextureName, SlotName> | Exclude<SlotName, MaterialTextureName>] extends [never] ? true : never = true;
void textureNamesMatch;
export type MaterialTextureIndex = typeof slots[number]['index'];

export const MATERIAL_TEXTURE_SLOTS = slots.map(slot => {
  const field = materialLayoutFields().find(field => field.source === slot.index);
  if (!field) throw new Error(`Missing packed texture index: ${slot.property}`);
  return { ...slot, packed: {
    row: field.row, component: field.component, wgslField: field.name,
    glslRow: `MAT_ROW_${MATERIAL_LAYOUT[field.row].name}`,
    glslComponent: 'xyzw'[field.component]
  } };
});

export const MATERIAL_TEXTURE_FEATURE_BITS = Object.fromEntries(slots.flatMap(slot => slot.feature
  ? [[slot.feature, slot.featureBit]] : []));
export const MATERIAL_TEXTURE_DEFINES = slots.flatMap(slot => slot.define ? [slot.define] : []);

export function materialTextureFeatures(defines: Record<string, string | number>) {
  return Object.fromEntries(MATERIAL_TEXTURE_SLOTS.flatMap(slot => slot.feature && slot.define
    ? [[slot.feature, +defines[slot.define] > 0]] : []));
}

// Call at each original sample site: alpha resolution and combined maps must
// keep their existing order. The scalar factors use raw linear channels; film ranges resolve explicitly.
export function simpleTextureSample(property: MaterialTextureName, backend: 'wgsl' | 'glsl'): string {
  const slot = MATERIAL_TEXTURE_SLOTS.find(slot => slot.property === property);
  if (!slot || slot.sampling !== 'multiply') throw new Error(`Handwritten texture slot: ${property}`);
  const index = slot.index;
  const sample = (expression: string) => slot.colorSpace === 'srgb' ? `decodeMapColor(${index}, ${expression})` : expression;
  if (backend === 'wgsl') {
    return `
  if (${slot.feature}) {
    let ${index} = i32(matData.${slot.packed.wgslField});
    if (${index} >= 0) {
      (*ma).${slot.target} *= ${sample(`sampleMap(
        ${index}, getMapUvSet(${index}, uv, uv1)
      ).${slot.channel}`)};
    }
  }
`;
  }
  return `
  #ifdef ${slot.define}
    int ${index} = int(fetchMatData(i + ${slot.packed.glslRow}).${slot.packed.glslComponent});
    if (${index} >= 0) {
      mat.${slot.target} *= ${sample(`sampleMap(
        ${index}, getMapUvSet(${index}, uv, uv1)
      ).${slot.channel}`)};
    }
  #endif
`;
}

// Multi-parameter slots retain explicit resolution and their original sample site.
export function thinFilmTextureSample(backend: 'wgsl' | 'glsl'): string {
  const slot = MATERIAL_TEXTURE_SLOTS.find(slot => slot.property === 'thinFilmMap')!;
  if (backend === 'wgsl') return `
  if (${slot.feature}) {
    let thinFilmMapIndex = i32(matData.${slot.packed.wgslField});
    if (thinFilmMapIndex >= 0) {
      let filmTexel = sampleMap(thinFilmMapIndex, getMapUvSet(thinFilmMapIndex, uv, uv1));
      // Preserve the legacy nm conversion followed by R multiplication exactly.
      if (matData.thinFilmThicknessMinimum == 0.0 && matData.thinFilmMapChannel == 0.0) {
        (*ma).thinFilmThickness *= filmTexel.r;
      } else {
        (*ma).thinFilmThickness = mix(matData.thinFilmThicknessMinimum,
          matData.thinFilmThickness, filmTexel[i32(matData.thinFilmMapChannel)]) * 1000.0;
      }
    }
  }
`;
  return `
  #ifdef ${slot.define}
    int thinFilmMapIndex = int(fetchMatData(i + ${slot.packed.glslRow}).${slot.packed.glslComponent});
    if (thinFilmMapIndex >= 0) {
      vec4 filmTexel = sampleMap(thinFilmMapIndex, getMapUvSet(thinFilmMapIndex, uv, uv1));
      vec4 filmTextureParams = fetchMatData(i + MAT_ROW_FILM_TEXTURE);
      if (filmTextureParams.z == 0.0 && filmTextureParams.w == 0.0) {
        mat.thinFilmThickness *= filmTexel.r;
      } else {
        mat.thinFilmThickness = mix(filmTextureParams.z, misc.b,
          filmTexel[int(filmTextureParams.w)]) * 1000.0;
      }
    }
  #endif
`;
}
