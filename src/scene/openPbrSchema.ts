import type { default as OpenPBRMaterial, OpenPBRMaterialParams } from './OpenPBRMaterial.js';
import Texture from './Texture.js';
import type { MaterialTextureName } from './materialTextureNames.js';
import { specularAnisotropyModelIndex } from './anisotropyParameters.js';
import { thinFilmMapChannelIndex } from './thinFilmParameters.js';

export const materialAliases = {
  specularRoughnessAnisotropy: 'specularAnisotropy',
  coatRoughnessAnisotropy: 'coatAnisotropy',
  subsurfaceScatterAnisotropy: 'subsurfaceAnisotropy',
  geometryOpacity: 'opacity',
  geometryThinWalled: 'thinWalled'
} as const;
type MaterialKey = Exclude<keyof OpenPBRMaterial, keyof typeof materialAliases>;
// Constructor and Three.js metadata share conflict handling before either mutates storage.
export function normalizeMaterialParams(params: OpenPBRMaterialParams | Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {...params};
  for (const alias of Object.keys(materialAliases) as (keyof typeof materialAliases)[]) {
    const old = materialAliases[alias];
    if (params[alias] === undefined) continue;
    if (params[old] !== undefined && params[old] !== params[alias]) {
      throw new Error(`Conflicting OpenPBR material parameters: ${alias} and ${old}`);
    }
    Object.assign(normalized, {[old]: params[alias]});
    delete normalized[alias];
  }
  return normalized;
}
type Field = {[K in MaterialKey]: {key: K; type: 'float' | 'color' | 'bool' | 'enum' | 'vec2' | 'texture'; default: OpenPBRMaterial[K]; category: 'param' | 'texture' | 'geometry'}}[MaterialKey];
// Order is part of the existing deduplication hash contract.
export const openPbrSchema = [
  {key: 'baseWeight', type: 'float', default: 1, category: 'param'},
  {key: 'baseColor', type: 'color', default: [0.8, 0.8, 0.8], category: 'param'},
  {key: 'baseDiffuseRoughness', type: 'float', default: 0, category: 'param'},
  {key: 'baseMetalness', type: 'float', default: 0, category: 'param'},
  {key: 'specularWeight', type: 'float', default: 1, category: 'param'},
  {key: 'specularColor', type: 'color', default: [1, 1, 1], category: 'param'},
  {key: 'specularRoughness', type: 'float', default: 0.3, category: 'param'},
  {key: 'specularIor', type: 'float', default: 1.5, category: 'param'},
  {key: 'specularAnisotropy', type: 'float', default: 0, category: 'param'},
  {key: 'transmissionWeight', type: 'float', default: 0, category: 'param'},
  {key: 'transmissionColor', type: 'color', default: [1, 1, 1], category: 'param'},
  {key: 'transmissionDepth', type: 'float', default: 0, category: 'param'},
  {key: 'transmissionScatter', type: 'color', default: [0, 0, 0], category: 'param'},
  {key: 'transmissionScatterAnisotropy', type: 'float', default: 0, category: 'param'},
  {key: 'transmissionDispersionScale', type: 'float', default: 0, category: 'param'},
  {key: 'transmissionDispersionAbbeNumber', type: 'float', default: 20, category: 'param'},
  {key: 'subsurfaceWeight', type: 'float', default: 0, category: 'param'},
  {key: 'subsurfaceColor', type: 'color', default: [0.8, 0.8, 0.8], category: 'param'},
  {key: 'subsurfaceRadius', type: 'float', default: 1, category: 'param'},
  {key: 'subsurfaceRadiusScale', type: 'color', default: [1, 0.5, 0.25], category: 'param'},
  {key: 'subsurfaceAnisotropy', type: 'float', default: 0, category: 'param'},
  {key: 'fuzzWeight', type: 'float', default: 0, category: 'param'},
  {key: 'fuzzColor', type: 'color', default: [1, 1, 1], category: 'param'},
  {key: 'fuzzRoughness', type: 'float', default: 0.5, category: 'param'},
  {key: 'coatWeight', type: 'float', default: 0, category: 'param'},
  {key: 'coatColor', type: 'color', default: [1, 1, 1], category: 'param'},
  {key: 'coatRoughness', type: 'float', default: 0, category: 'param'},
  {key: 'coatAnisotropy', type: 'float', default: 0, category: 'param'},
  {key: 'coatIor', type: 'float', default: 1.6, category: 'param'},
  {key: 'coatDarkening', type: 'float', default: 1, category: 'param'},
  {key: 'thinFilmWeight', type: 'float', default: 0, category: 'param'},
  {key: 'thinFilmThickness', type: 'float', default: 0.5, category: 'param'},
  {key: 'thinFilmIor', type: 'float', default: 1.4, category: 'param'},
  {key: 'emissionColor', type: 'color', default: [1, 1, 1], category: 'param'},
  {key: 'emissionLuminance', type: 'float', default: 0, category: 'param'},
  {key: 'opacity', type: 'float', default: 1, category: 'param'},
  {key: 'thinWalled', type: 'bool', default: false, category: 'param'},
  {key: 'doubleSided', type: 'bool', default: false, category: 'param'},
  {key: 'map', type: 'texture', default: undefined, category: 'texture'},
  {key: 'alphaMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'alphaMode', type: 'enum', default: 'auto', category: 'param'},
  {key: 'alphaCutoff', type: 'float', default: 0, category: 'param'},
  {key: 'emissiveMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'normalMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'normalScale', type: 'vec2', default: [1, 1], category: 'param'},
  {key: 'metallicRoughnessMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'roughnessMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'metalnessMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'transmissionMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'thinFilmMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'shadowCatcher', type: 'bool', default: false, category: 'param'},
  {key: 'unlit', type: 'bool', default: false, category: 'param'},
  {key: 'bevelSize', type: 'float', default: 0, category: 'param'},
  {key: 'mapAlphaUsage', type: 'enum', default: 'opaque', category: 'param'},
  {key: 'uvProjection', type: 'enum', default: 'none', category: 'param'},
  {key: 'uvProjectionScale', type: 'vec2', default: [1, 1], category: 'param'},
  {key: 'displacementUvProjection', type: 'enum', default: 'none', category: 'geometry'},
  {key: 'displacementUvProjectionScale', type: 'float', default: 1, category: 'geometry'},
  {key: 'displacementMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'displacementScale', type: 'float', default: 0.1, category: 'geometry'},
  {key: 'displacementStepSize', type: 'float', default: 0, category: 'geometry'},
  {key: 'thinFilmThicknessMinimum', type: 'float', default: 0, category: 'param'},
  {key: 'thinFilmMapChannel', type: 'enum', default: 'r', category: 'param'},
  {key: 'coatWeightMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'coatRoughnessMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'fuzzColorMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'fuzzRoughnessMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'specularWeightMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'specularColorMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'anisotropyMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'specularAnisotropyRotation', type: 'float', default: 0, category: 'param'},
  {key: 'coatAnisotropyRotation', type: 'float', default: 0, category: 'param'},
  {key: 'specularAnisotropyModel', type: 'enum', default: 'openpbr', category: 'param'},
  {key: 'coatNormalMap', type: 'texture', default: undefined, category: 'texture'},
  {key: 'coatNormalScale', type: 'vec2', default: [1, 1], category: 'param'},
  {key: 'displacementBias', type: 'float', default: 0, category: 'geometry'},
] as const satisfies readonly Field[];
type SchemaTextureName = Extract<typeof openPbrSchema[number], {type: 'texture'}>['key'];
const textureNamesMatch: [Exclude<MaterialTextureName, SchemaTextureName> | Exclude<SchemaTextureName, MaterialTextureName>] extends [never] ? true : never = true;
void textureNamesMatch;
type Keys<T extends readonly {key: PropertyKey}[]> = {readonly [I in keyof T]: T[I]['key']};
type CategoryKeys<T extends readonly Field[], C extends Field['category'], R extends readonly MaterialKey[] = []> =
  T extends readonly [infer H extends Field, ...infer Rest extends readonly Field[]]
    ? CategoryKeys<Rest, C, H['category'] extends C ? readonly [...R, H['key']] : R> : R;
export const materialKeys = openPbrSchema.map(field => field.key) as unknown as Keys<typeof openPbrSchema>;
function categoryKeys<C extends Field['category']>(category: C) {
  return openPbrSchema.filter(field => field.category === category).map(field => field.key) as unknown as CategoryKeys<typeof openPbrSchema, C>;
}
export const materialTextureKeys = categoryKeys('texture');
export const materialGeometryKeys = categoryKeys('geometry');
export const materialParamKeys = categoryKeys('param');
const defaults = new Map<MaterialKey, unknown>(openPbrSchema.map(field => [field.key, field.default]));
export function materialDefault<K extends MaterialKey>(key: K): OpenPBRMaterial[K] {
  const value = defaults.get(key);
  return (Array.isArray(value) ? value.slice() : value) as OpenPBRMaterial[K];
}
export function applyMaterialParams(material: OpenPBRMaterial, input: OpenPBRMaterialParams) {
  const params = normalizeMaterialParams(input);
  if (params.thinFilmMapChannel !== undefined) thinFilmMapChannelIndex(params.thinFilmMapChannel);
  if (params.specularAnisotropyModel !== undefined) specularAnisotropyModelIndex(params.specularAnisotropyModel);
  for (const {key} of openPbrSchema) {
    if (params[key] !== undefined) Object.assign(material, {[key]: params[key]});
  }
}
let textureId = 1;
const textureWeakMap = new WeakMap<Texture, number>();
export function resetMaterialTextureId() { textureId = 1; }
export function getMaterialHashKey(material: OpenPBRMaterial) {
  return openPbrSchema.map(({key}) => {
    const value = material[key];
    if (value == null) return '$';
    if (value instanceof Texture) {
      if (!textureWeakMap.has(value)) textureWeakMap.set(value, textureId++);
      return `${textureWeakMap.get(value)!}@${value.version}`;
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && 'length' in value) return Array.from(value as ArrayLike<number>).join('_');
    return value;
  }).join('_');
}
