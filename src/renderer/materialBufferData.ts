import type { MaterialTextureIndex } from './materialTextureSlots.js';
import type { ColorRGB } from '../types.js';
import type { vec2 } from '../math.js';
import type { ShadowCatcherMaterial, UnlitMaterial } from '../constants.js';

export interface BufferData extends Record<MaterialTextureIndex, number[]> {
  color: ColorRGB[];
  roughness: number[];
  metallic: number[];
  emission: ColorRGB[];
  ior: number[];
  transmission: number[];
  dispersion: number[];
  thinFilmThickness: number[];
  thinFilmThicknessMinimum: number[];
  thinFilmMapChannel: number[];
  thinFilmIor: number[];
  anisotropy: number[];
  thin: number[];
  doubleSided: number[];
  bevelSize: number[];
  mapAlphaUsage: number[];

  normalScale: vec2.Vec2Array[];

  type: (typeof ShadowCatcherMaterial | typeof UnlitMaterial | 0)[];
  mapInfo: number[];
  mapTransform: number[];
  mapUvChannel: number[];
  mapColorLinear: number[];

  mediumType: number[];
  specularAnisotropyModel: number[];
  specularAnisotropyRotation: number[];
  coatAnisotropyRotation: number[];
  coatNormalScale: vec2.Vec2Array[];

  uvProjection: number[];
  uvScale: vec2.Vec2Array[];

  displacementUvProjection: number[];
  displacementUvProjectionScale: number[];

  // For PDM displacement.
  displacementStepSize: number[];

  // Alpha
  alpha: number[];
  alphaMode: number[];
  alphaCutoff: number[];

  baseWeight: number[];
  baseDiffuseRoughness: number[];
  specularWeight: number[];
  specularColor: ColorRGB[];
  transmissionColor: ColorRGB[];
  transmissionDepth: number[];
  transmissionScatter: ColorRGB[];
  transmissionScatterAnisotropy: number[];
  subsurfaceWeight: number[];
  subsurfaceColor: ColorRGB[];
  subsurfaceRadius: number[];
  subsurfaceRadiusScale: ColorRGB[];
  subsurfaceScatterAnisotropy: number[];
  fuzzWeight: number[];
  fuzzColor: ColorRGB[];
  fuzzRoughness: number[];
  coatWeight: number[];
  coatColor: ColorRGB[];
  coatRoughness: number[];
  coatAnisotropy: number[];
  coatIor: number[];
  coatDarkening: number[];
  thinFilmWeight: number[];
  dispersionAbbeNumber: number[];
  mediumExtinction: ColorRGB[];
  mediumScattering: ColorRGB[];
  mediumAnisotropy: number[];
}
