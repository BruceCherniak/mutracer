import type { vec2 } from '../math.js';
import type { BufferData } from './materialBufferData.js';

// Internal GPU contract. Each row occupies one vec4 (16 bytes). Reserved fields
// retain their legacy sources/zero bytes; reuse requires an intentional migration.
type FieldType = 'f32' | 'vec2f' | 'vec3f';
type Source<T extends FieldType> = {
  [K in keyof BufferData]: BufferData[K] extends (T extends 'f32' ? number[] :
    T extends 'vec2f' ? vec2.Vec2Array[] : [number, number, number][]) ? K : never
}[keyof BufferData];
export interface MaterialLayoutField {
  name: string;
  source: keyof BufferData | null;
  type: FieldType;
  reserved: boolean;
}
function field<T extends FieldType>(name: string, source: Source<T> | null,
  type: T, reserved = false): MaterialLayoutField {
  return { name, source, type, reserved };
}

export const MATERIAL_LAYOUT: readonly { readonly name: string; readonly fields: readonly MaterialLayoutField[] }[] = [
  { name: 'COLOR', fields: [
    field('color', 'color', 'vec3f'),
    field('matType', 'type', 'f32')
  ] },
  { name: 'ROUGHNESS_NORMAL', fields: [
    field('roughness', 'roughness', 'f32'),
    field('normalMapIndex', 'normalMapIndex', 'f32'),
    field('normalMapScale', 'normalScale', 'vec2f')
  ] },
  { name: 'METALLIC_MAPS', fields: [
    field('metallic', 'metallic', 'f32'),
    field('anisotropy', 'anisotropy', 'f32'),
    field('diffuseMapIndex', 'diffuseMapIndex', 'f32'),
    field('mrtMapIndex', 'metallicRoughnessMapIndex', 'f32')
  ] },
  { name: 'EMISSION', fields: [
    field('emission', 'emission', 'vec3f'),
    field('emissiveMapIndex', 'emissiveMapIndex', 'f32')
  ] },
  { name: 'IOR_TRANSMISSION', fields: [
    field('ior', 'ior', 'f32'),
    field('transmission', 'transmission', 'f32'),
    field('mediumType', 'mediumType', 'f32', true),
    field('thin', 'thin', 'f32')
  ] },
  { name: 'MISC', fields: [
    field('bevel', 'bevelSize', 'f32'),
    field('dispersion', 'dispersion', 'f32'),
    field('thinFilmThickness', 'thinFilmThickness', 'f32'),
    field('mapAlphaUsage', 'mapAlphaUsage', 'f32')
  ] },
  { name: 'LAYER_MAPS', fields: [
    field('coatWeightMapIndex', 'coatWeightMapIndex', 'f32'),
    field('coatRoughnessMapIndex', 'coatRoughnessMapIndex', 'f32'),
    field('coatNormalMapIndex', 'coatNormalMapIndex', 'f32'),
    field('fuzzColorMapIndex', 'fuzzColorMapIndex', 'f32')
  ] },
  { name: 'UV', fields: [
    field('uvProjection', 'uvProjection', 'f32'),
    field('displacementMapIndex', 'displacementMapIndex', 'f32'),
    field('uvScale', 'uvScale', 'vec2f')
  ] },
  { name: 'DISPLACEMENT', fields: [
    field('displacementStepSize', 'displacementStepSize', 'f32'),
    field('displacementBias', 'displacementBias', 'f32'),
    field('displacementUvProjection', 'displacementUvProjection', 'f32'),
    field('displacementUvProjectionScale', 'displacementUvProjectionScale', 'f32')
  ] },
  { name: 'ALPHA_FILM', fields: [
    field('alpha', 'alpha', 'f32'),
    field('thinFilmMapIndex', 'thinFilmMapIndex', 'f32'),
    field('thinFilmIor', 'thinFilmIor', 'f32'),
    field('transmissionMapIndex', 'transmissionMapIndex', 'f32')
  ] },
  { name: 'BASE_CONTROLS', fields: [
    field('baseWeight', 'baseWeight', 'f32'),
    field('baseDiffuseRoughness', 'baseDiffuseRoughness', 'f32'),
    field('specularWeight', 'specularWeight', 'f32'),
    field('subsurfaceWeight', 'subsurfaceWeight', 'f32')
  ] },
  { name: 'SPECULAR_FUZZ', fields: [
    field('specularColor', 'specularColor', 'vec3f'),
    field('fuzzWeight', 'fuzzWeight', 'f32')
  ] },
  { name: 'TRANSMISSION_COLOR', fields: [
    field('transmissionColor', 'transmissionColor', 'vec3f'),
    field('transmissionDepth', 'transmissionDepth', 'f32')
  ] },
  { name: 'TRANSMISSION_SCATTER', fields: [
    field('transmissionScatter', 'transmissionScatter', 'vec3f'),
    field('transmissionScatterAnisotropy', 'transmissionScatterAnisotropy', 'f32')
  ] },
  { name: 'SUBSURFACE', fields: [
    field('subsurfaceColor', 'subsurfaceColor', 'vec3f'),
    field('subsurfaceRadius', 'subsurfaceRadius', 'f32')
  ] },
  { name: 'FUZZ', fields: [
    field('fuzzColor', 'fuzzColor', 'vec3f'),
    field('fuzzRoughness', 'fuzzRoughness', 'f32')
  ] },
  { name: 'COAT', fields: [
    field('coatColor', 'coatColor', 'vec3f'),
    field('coatWeight', 'coatWeight', 'f32')
  ] },
  { name: 'COAT_CONTROLS', fields: [
    field('coatRoughness', 'coatRoughness', 'f32'),
    field('coatAnisotropy', 'coatAnisotropy', 'f32'),
    field('coatIor', 'coatIor', 'f32'),
    field('coatDarkening', 'coatDarkening', 'f32')
  ] },
  { name: 'FILM_DISPERSION', fields: [
    field('thinFilmWeight', 'thinFilmWeight', 'f32'),
    field('dispersionAbbeNumber', 'dispersionAbbeNumber', 'f32'),
    field('subsurfaceScatterAnisotropy', 'subsurfaceScatterAnisotropy', 'f32'),
    field('fuzzRoughnessMapIndex', 'fuzzRoughnessMapIndex', 'f32')
  ] },
  { name: 'SUBSURFACE_RADIUS', fields: [
    field('subsurfaceRadiusScale', 'subsurfaceRadiusScale', 'vec3f'),
    field('specularWeightMapIndex', 'specularWeightMapIndex', 'f32')
  ] },
  { name: 'MEDIUM_EXTINCTION', fields: [
    field('mediumExtinction', 'mediumExtinction', 'vec3f'),
    field('mediumAnisotropy', 'mediumAnisotropy', 'f32')
  ] },
  { name: 'MEDIUM_SCATTERING', fields: [
    field('mediumScattering', 'mediumScattering', 'vec3f'),
    field('specularColorMapIndex', 'specularColorMapIndex', 'f32')
  ] },
  { name: 'STANDALONE_MAPS', fields: [
    field('roughnessMapIndex', 'roughnessMapIndex', 'f32'),
    field('metalnessMapIndex', 'metalnessMapIndex', 'f32'),
    field('alphaMapIndex', 'alphaMapIndex', 'f32'),
    field('alphaCutoff', 'alphaCutoff', 'f32')
  ] },
  { name: 'ALPHA', fields: [
    field('_padding1', null, 'f32', true),
    field('_padding2', null, 'f32', true),
    field('doubleSided', 'doubleSided', 'f32'),
    field('alphaMode', 'alphaMode', 'f32')
  ] },
  // Reserve the approved direction/normal inputs for C1 steps two and three.
  { name: 'DIRECTION_NORMAL', fields: [
    field('anisotropyMapIndex', 'anisotropyMapIndex', 'f32'),
    field('specularAnisotropyRotation', 'specularAnisotropyRotation', 'f32'),
    field('coatNormalScale', 'coatNormalScale', 'vec2f')
  ] },
  { name: 'FILM_TEXTURE', fields: [
    field('coatAnisotropyRotation', 'coatAnisotropyRotation', 'f32'),
    field('specularAnisotropyModel', 'specularAnisotropyModel', 'f32'),
    field('thinFilmThicknessMinimum', 'thinFilmThicknessMinimum', 'f32'),
    field('thinFilmMapChannel', 'thinFilmMapChannel', 'f32')
  ] },
];

export const MATERIAL_ROW_COUNT = MATERIAL_LAYOUT.length;
export const MATERIAL_FLOAT_COUNT = MATERIAL_ROW_COUNT * 4;
const components = { f32: 1, vec2f: 2, vec3f: 3 } as const;
export function materialLayoutFields() {
  return MATERIAL_LAYOUT.flatMap((row, rowIndex) => {
    let component = 0;
    return row.fields.map(field => {
      const offset = rowIndex * 16 + component * 4;
      component += components[field.type];
      return { name: field.name, source: field.source, type: field.type,
        reserved: field.reserved, row: rowIndex, component: offset % 16 / 4, offset };
    });
  });
}


export function materialBufferWgsl(): string {
  let end = 0;
  const declarations = materialLayoutFields().map(field => {
    const alignment = field.type === 'vec3f' ? 16 : components[field.type] * 4;
    const aligned = Math.ceil(end / alignment) * alignment;
    if (aligned !== field.offset) throw new Error(`Misaligned material field: ${field.name}`);
    end = aligned + components[field.type] * 4;
    return `  ${field.name}: ${field.type},`;
  });
  if (Math.ceil(end / 16) * 16 !== MATERIAL_ROW_COUNT * 16) {
    throw new Error('Invalid material buffer size');
  }
  return `struct MaterialBuffer {\n${declarations.join('\n')}\n};`;
}

export function materialRowsGlsl(): string {
  return [`const int MAT_DATA_SIZE = ${MATERIAL_ROW_COUNT};`,
    ...MATERIAL_LAYOUT.map((row, index) => `const int MAT_ROW_${row.name} = ${index};`)
  ].join('\n');
}
