import type { BufferData } from './materialBufferData.js';
import type { ColorRGB } from '../types.js';
import type { vec2 } from '../math.js';
import { materialLayoutFields, MATERIAL_FLOAT_COUNT } from './materialLayoutSchema.js';
export * from './materialLayoutSchema.js';
const components = { f32: 1, vec2f: 2, vec3f: 3 } as const;

function flattenColors(values: ColorRGB[] | undefined): number[] {
  const result: number[] = [];
  if (!values) return result;
  for (const value of values) {
    const array = value as readonly number[];
    for (let i = 0; i < array.length; i++) result.push(array[i]);
  }
  return result;
}
function flattenVectors(values: vec2.Vec2Array[] | undefined): number[] {
  const result: number[] = [];
  if (!values) return result;
  for (const value of values) {
    // Array.flat leaves typed arrays intact; Number then converts each as one
    // entry. Preserve that existing behavior, including non-finite conversion.
    if (value instanceof Float32Array) {
      result.push(value.length === 0 ? 0 : value.length === 1 ? value[0] : NaN);
    } else {
      for (let i = 0; i < value.length; i++) result.push(value[i]);
    }
  }
  return result;
}

export function packMaterialBuffer(data: BufferData): Float32Array {
  const values: Record<string, number[]> = {
    color: flattenColors(data.color),
    type: data.type?.flat() ?? [],
    roughness: data.roughness?.flat() ?? [],
    normalMapIndex: data.normalMapIndex?.flat() ?? [],
    normalScale: flattenVectors(data.normalScale),
    metallic: data.metallic?.flat() ?? [],
    anisotropy: data.anisotropy?.flat() ?? [],
    diffuseMapIndex: data.diffuseMapIndex?.flat() ?? [],
    metallicRoughnessMapIndex: data.metallicRoughnessMapIndex?.flat() ?? [],
    emission: flattenColors(data.emission),
    emissiveMapIndex: data.emissiveMapIndex?.flat() ?? [],
    ior: data.ior?.flat() ?? [],
    transmission: data.transmission?.flat() ?? [],
    mediumType: data.mediumType?.flat() ?? [],
    thin: data.thin?.flat() ?? [],
    bevelSize: data.bevelSize?.flat() ?? [],
    dispersion: data.dispersion?.flat() ?? [],
    thinFilmThickness: data.thinFilmThickness?.flat() ?? [],
    mapAlphaUsage: data.mapAlphaUsage?.flat() ?? [],
    coatWeightMapIndex: data.coatWeightMapIndex?.flat() ?? [],
    coatRoughnessMapIndex: data.coatRoughnessMapIndex?.flat() ?? [],
    coatNormalMapIndex: data.coatNormalMapIndex?.flat() ?? [],
    fuzzColorMapIndex: data.fuzzColorMapIndex?.flat() ?? [],
    uvProjection: data.uvProjection?.flat() ?? [],
    displacementMapIndex: data.displacementMapIndex?.flat() ?? [],
    uvScale: flattenVectors(data.uvScale),
    displacementStepSize: data.displacementStepSize?.flat() ?? [],
    displacementBias: data.displacementBias?.flat() ?? [],
    displacementUvProjection: data.displacementUvProjection?.flat() ?? [],
    displacementUvProjectionScale: data.displacementUvProjectionScale?.flat() ?? [],
    alpha: data.alpha?.flat() ?? [],
    thinFilmMapIndex: data.thinFilmMapIndex?.flat() ?? [],
    thinFilmIor: data.thinFilmIor?.flat() ?? [],
    transmissionMapIndex: data.transmissionMapIndex?.flat() ?? [],
    baseWeight: data.baseWeight?.flat() ?? [],
    baseDiffuseRoughness: data.baseDiffuseRoughness?.flat() ?? [],
    specularWeight: data.specularWeight?.flat() ?? [],
    subsurfaceWeight: data.subsurfaceWeight?.flat() ?? [],
    specularColor: flattenColors(data.specularColor),
    fuzzWeight: data.fuzzWeight?.flat() ?? [],
    transmissionColor: flattenColors(data.transmissionColor),
    transmissionDepth: data.transmissionDepth?.flat() ?? [],
    transmissionScatter: flattenColors(data.transmissionScatter),
    transmissionScatterAnisotropy: data.transmissionScatterAnisotropy?.flat() ?? [],
    subsurfaceColor: flattenColors(data.subsurfaceColor),
    subsurfaceRadius: data.subsurfaceRadius?.flat() ?? [],
    fuzzColor: flattenColors(data.fuzzColor),
    fuzzRoughness: data.fuzzRoughness?.flat() ?? [],
    coatColor: flattenColors(data.coatColor),
    coatWeight: data.coatWeight?.flat() ?? [],
    coatRoughness: data.coatRoughness?.flat() ?? [],
    coatAnisotropy: data.coatAnisotropy?.flat() ?? [],
    coatIor: data.coatIor?.flat() ?? [],
    coatDarkening: data.coatDarkening?.flat() ?? [],
    thinFilmWeight: data.thinFilmWeight?.flat() ?? [],
    dispersionAbbeNumber: data.dispersionAbbeNumber?.flat() ?? [],
    subsurfaceScatterAnisotropy: data.subsurfaceScatterAnisotropy?.flat() ?? [],
    fuzzRoughnessMapIndex: data.fuzzRoughnessMapIndex?.flat() ?? [],
    subsurfaceRadiusScale: flattenColors(data.subsurfaceRadiusScale),
    specularWeightMapIndex: data.specularWeightMapIndex?.flat() ?? [],
    mediumExtinction: flattenColors(data.mediumExtinction),
    mediumAnisotropy: data.mediumAnisotropy?.flat() ?? [],
    mediumScattering: flattenColors(data.mediumScattering),
    specularColorMapIndex: data.specularColorMapIndex?.flat() ?? [],
    roughnessMapIndex: data.roughnessMapIndex?.flat() ?? [],
    metalnessMapIndex: data.metalnessMapIndex?.flat() ?? [],
    alphaMapIndex: data.alphaMapIndex?.flat() ?? [],
    alphaCutoff: data.alphaCutoff?.flat() ?? [],
    doubleSided: data.doubleSided?.flat() ?? [],
    alphaMode: data.alphaMode?.flat() ?? [],
    anisotropyMapIndex: data.anisotropyMapIndex?.flat() ?? [],
    specularAnisotropyRotation: data.specularAnisotropyRotation?.flat() ?? [],
    coatNormalScale: flattenVectors(data.coatNormalScale),
    coatAnisotropyRotation: data.coatAnisotropyRotation?.flat() ?? [],
    specularAnisotropyModel: data.specularAnisotropyModel?.flat() ?? [],
    thinFilmThicknessMinimum: data.thinFilmThicknessMinimum?.flat() ?? [],
    thinFilmMapChannel: data.thinFilmMapChannel?.flat() ?? [],
  };
  const fields = materialLayoutFields().map(field => ({
    type: field.type, offset: field.offset,
    values: field.source === null ? data.type.map(() => 0) : values[field.source] ?? []
  }));
  const packed = new Float32Array(data.type.length * MATERIAL_FLOAT_COUNT);
  for (let material = 0; material < data.type.length; material++) {
    for (const field of fields) {
      const width = components[field.type];
      for (let c = 0; c < width; c++) {
        packed[material * MATERIAL_FLOAT_COUNT + field.offset / 4 + c] =
          Number(field.values[material * width + c] ?? -1);
      }
    }
  }
  return packed;
}
