// Stable public names. Renderer descriptors own packing and sampling details.
// Append new slots to preserve atlas traversal and hash contracts.
export const MATERIAL_TEXTURE_NAMES = [
  'map', 'alphaMap', 'normalMap', 'emissiveMap', 'metallicRoughnessMap',
  'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'displacementMap',
  'coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap',
  'specularWeightMap', 'specularColorMap', 'anisotropyMap', 'coatNormalMap'
] as const;
export type MaterialTextureName = typeof MATERIAL_TEXTURE_NAMES[number];
