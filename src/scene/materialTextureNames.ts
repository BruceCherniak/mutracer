// Stable public names. Renderer descriptors own packing and sampling details.
// Normal and anisotropy inputs are added when their separate implementations land.
export const MATERIAL_TEXTURE_NAMES = [
  'map', 'alphaMap', 'normalMap', 'emissiveMap', 'metallicRoughnessMap',
  'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'displacementMap',
  'coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap',
  'specularWeightMap', 'specularColorMap'
] as const;
export type MaterialTextureName = typeof MATERIAL_TEXTURE_NAMES[number];
