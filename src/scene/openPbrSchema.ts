import type { default as MaterialState, MaterialStateParams } from './MaterialState.js';
import TextureState from './TextureState.js';
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
type MaterialKey = Exclude<keyof MaterialState, keyof typeof materialAliases>;
// Constructor and Three.js metadata share conflict handling before either mutates storage.
export function normalizeMaterialParams(params: MaterialStateParams | Record<string, unknown>): Record<string, unknown> {
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
type Field = {[K in MaterialKey]: {key: K; type: 'float' | 'color' | 'bool' | 'enum' | 'vec2' | 'texture'; default: MaterialState[K]; category: 'param' | 'texture' | 'geometry'}}[MaterialKey];
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
// Fixed tuple literals preserve the typed key-order contract in native builds;
// satisfies checks every position against the schema at compile time.
export const materialKeys = [
  'baseWeight', 'baseColor', 'baseDiffuseRoughness', 'baseMetalness', 'specularWeight', 'specularColor', 'specularRoughness', 'specularIor', 'specularAnisotropy', 'transmissionWeight', 'transmissionColor', 'transmissionDepth', 'transmissionScatter', 'transmissionScatterAnisotropy', 'transmissionDispersionScale', 'transmissionDispersionAbbeNumber', 'subsurfaceWeight', 'subsurfaceColor', 'subsurfaceRadius', 'subsurfaceRadiusScale', 'subsurfaceAnisotropy', 'fuzzWeight', 'fuzzColor', 'fuzzRoughness', 'coatWeight', 'coatColor', 'coatRoughness', 'coatAnisotropy', 'coatIor', 'coatDarkening', 'thinFilmWeight', 'thinFilmThickness', 'thinFilmIor', 'emissionColor', 'emissionLuminance', 'opacity', 'thinWalled', 'doubleSided', 'map', 'alphaMap', 'alphaMode', 'alphaCutoff', 'emissiveMap', 'normalMap', 'normalScale', 'metallicRoughnessMap', 'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'shadowCatcher', 'unlit', 'bevelSize', 'mapAlphaUsage', 'uvProjection', 'uvProjectionScale', 'displacementUvProjection', 'displacementUvProjectionScale', 'displacementMap', 'displacementScale', 'displacementStepSize', 'thinFilmThicknessMinimum', 'thinFilmMapChannel', 'coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap', 'specularWeightMap', 'specularColorMap', 'anisotropyMap', 'specularAnisotropyRotation', 'coatAnisotropyRotation', 'specularAnisotropyModel', 'coatNormalMap', 'coatNormalScale', 'displacementBias'
] as const satisfies Keys<typeof openPbrSchema>;
export const materialTextureKeys = [
  'map', 'alphaMap', 'emissiveMap', 'normalMap', 'metallicRoughnessMap', 'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'displacementMap', 'coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap', 'specularWeightMap', 'specularColorMap', 'anisotropyMap', 'coatNormalMap'
] as const satisfies CategoryKeys<typeof openPbrSchema, 'texture'>;
export const materialGeometryKeys = [
  'displacementUvProjection', 'displacementUvProjectionScale', 'displacementScale', 'displacementStepSize', 'displacementBias'
] as const satisfies CategoryKeys<typeof openPbrSchema, 'geometry'>;
export const materialParamKeys = [
  'baseWeight', 'baseColor', 'baseDiffuseRoughness', 'baseMetalness', 'specularWeight', 'specularColor', 'specularRoughness', 'specularIor', 'specularAnisotropy', 'transmissionWeight', 'transmissionColor', 'transmissionDepth', 'transmissionScatter', 'transmissionScatterAnisotropy', 'transmissionDispersionScale', 'transmissionDispersionAbbeNumber', 'subsurfaceWeight', 'subsurfaceColor', 'subsurfaceRadius', 'subsurfaceRadiusScale', 'subsurfaceAnisotropy', 'fuzzWeight', 'fuzzColor', 'fuzzRoughness', 'coatWeight', 'coatColor', 'coatRoughness', 'coatAnisotropy', 'coatIor', 'coatDarkening', 'thinFilmWeight', 'thinFilmThickness', 'thinFilmIor', 'emissionColor', 'emissionLuminance', 'opacity', 'thinWalled', 'doubleSided', 'alphaMode', 'alphaCutoff', 'normalScale', 'shadowCatcher', 'unlit', 'bevelSize', 'mapAlphaUsage', 'uvProjection', 'uvProjectionScale', 'thinFilmThicknessMinimum', 'thinFilmMapChannel', 'specularAnisotropyRotation', 'coatAnisotropyRotation', 'specularAnisotropyModel', 'coatNormalScale'
] as const satisfies CategoryKeys<typeof openPbrSchema, 'param'>;
const defaults = new Map<MaterialKey, unknown>();
for (const field of openPbrSchema) defaults.set(field.key, field.default);
export function materialDefault<K extends MaterialKey>(key: K): MaterialState[K] {
  const value = defaults.get(key);
  return (Array.isArray(value) ? value.slice() : value) as MaterialState[K];
}
export function applyMaterialParams(material: MaterialState, input: MaterialStateParams) {
  const params = normalizeMaterialParams(input);
  if (params.thinFilmMapChannel !== undefined) thinFilmMapChannelIndex(params.thinFilmMapChannel);
  if (params.specularAnisotropyModel !== undefined) specularAnisotropyModelIndex(params.specularAnisotropyModel);
  // Literal fields preserve assignment order without native class reflection.
  if (params.baseWeight !== undefined) material.baseWeight = params.baseWeight as MaterialState['baseWeight'];
  if (params.baseColor !== undefined) material.baseColor = params.baseColor as MaterialState['baseColor'];
  if (params.baseDiffuseRoughness !== undefined) material.baseDiffuseRoughness = params.baseDiffuseRoughness as MaterialState['baseDiffuseRoughness'];
  if (params.baseMetalness !== undefined) material.baseMetalness = params.baseMetalness as MaterialState['baseMetalness'];
  if (params.specularWeight !== undefined) material.specularWeight = params.specularWeight as MaterialState['specularWeight'];
  if (params.specularColor !== undefined) material.specularColor = params.specularColor as MaterialState['specularColor'];
  if (params.specularRoughness !== undefined) material.specularRoughness = params.specularRoughness as MaterialState['specularRoughness'];
  if (params.specularIor !== undefined) material.specularIor = params.specularIor as MaterialState['specularIor'];
  if (params.specularAnisotropy !== undefined) material.specularAnisotropy = params.specularAnisotropy as MaterialState['specularAnisotropy'];
  if (params.transmissionWeight !== undefined) material.transmissionWeight = params.transmissionWeight as MaterialState['transmissionWeight'];
  if (params.transmissionColor !== undefined) material.transmissionColor = params.transmissionColor as MaterialState['transmissionColor'];
  if (params.transmissionDepth !== undefined) material.transmissionDepth = params.transmissionDepth as MaterialState['transmissionDepth'];
  if (params.transmissionScatter !== undefined) material.transmissionScatter = params.transmissionScatter as MaterialState['transmissionScatter'];
  if (params.transmissionScatterAnisotropy !== undefined) material.transmissionScatterAnisotropy = params.transmissionScatterAnisotropy as MaterialState['transmissionScatterAnisotropy'];
  if (params.transmissionDispersionScale !== undefined) material.transmissionDispersionScale = params.transmissionDispersionScale as MaterialState['transmissionDispersionScale'];
  if (params.transmissionDispersionAbbeNumber !== undefined) material.transmissionDispersionAbbeNumber = params.transmissionDispersionAbbeNumber as MaterialState['transmissionDispersionAbbeNumber'];
  if (params.subsurfaceWeight !== undefined) material.subsurfaceWeight = params.subsurfaceWeight as MaterialState['subsurfaceWeight'];
  if (params.subsurfaceColor !== undefined) material.subsurfaceColor = params.subsurfaceColor as MaterialState['subsurfaceColor'];
  if (params.subsurfaceRadius !== undefined) material.subsurfaceRadius = params.subsurfaceRadius as MaterialState['subsurfaceRadius'];
  if (params.subsurfaceRadiusScale !== undefined) material.subsurfaceRadiusScale = params.subsurfaceRadiusScale as MaterialState['subsurfaceRadiusScale'];
  if (params.subsurfaceAnisotropy !== undefined) material.subsurfaceAnisotropy = params.subsurfaceAnisotropy as MaterialState['subsurfaceAnisotropy'];
  if (params.fuzzWeight !== undefined) material.fuzzWeight = params.fuzzWeight as MaterialState['fuzzWeight'];
  if (params.fuzzColor !== undefined) material.fuzzColor = params.fuzzColor as MaterialState['fuzzColor'];
  if (params.fuzzRoughness !== undefined) material.fuzzRoughness = params.fuzzRoughness as MaterialState['fuzzRoughness'];
  if (params.coatWeight !== undefined) material.coatWeight = params.coatWeight as MaterialState['coatWeight'];
  if (params.coatColor !== undefined) material.coatColor = params.coatColor as MaterialState['coatColor'];
  if (params.coatRoughness !== undefined) material.coatRoughness = params.coatRoughness as MaterialState['coatRoughness'];
  if (params.coatAnisotropy !== undefined) material.coatAnisotropy = params.coatAnisotropy as MaterialState['coatAnisotropy'];
  if (params.coatIor !== undefined) material.coatIor = params.coatIor as MaterialState['coatIor'];
  if (params.coatDarkening !== undefined) material.coatDarkening = params.coatDarkening as MaterialState['coatDarkening'];
  if (params.thinFilmWeight !== undefined) material.thinFilmWeight = params.thinFilmWeight as MaterialState['thinFilmWeight'];
  if (params.thinFilmThickness !== undefined) material.thinFilmThickness = params.thinFilmThickness as MaterialState['thinFilmThickness'];
  if (params.thinFilmIor !== undefined) material.thinFilmIor = params.thinFilmIor as MaterialState['thinFilmIor'];
  if (params.emissionColor !== undefined) material.emissionColor = params.emissionColor as MaterialState['emissionColor'];
  if (params.emissionLuminance !== undefined) material.emissionLuminance = params.emissionLuminance as MaterialState['emissionLuminance'];
  if (params.opacity !== undefined) material.opacity = params.opacity as MaterialState['opacity'];
  if (params.thinWalled !== undefined) material.thinWalled = params.thinWalled as MaterialState['thinWalled'];
  if (params.doubleSided !== undefined) material.doubleSided = params.doubleSided as MaterialState['doubleSided'];
  if (params.map !== undefined) material.map = params.map as MaterialState['map'];
  if (params.alphaMap !== undefined) material.alphaMap = params.alphaMap as MaterialState['alphaMap'];
  if (params.alphaMode !== undefined) material.alphaMode = params.alphaMode as MaterialState['alphaMode'];
  if (params.alphaCutoff !== undefined) material.alphaCutoff = params.alphaCutoff as MaterialState['alphaCutoff'];
  if (params.emissiveMap !== undefined) material.emissiveMap = params.emissiveMap as MaterialState['emissiveMap'];
  if (params.normalMap !== undefined) material.normalMap = params.normalMap as MaterialState['normalMap'];
  if (params.normalScale !== undefined) material.normalScale = params.normalScale as MaterialState['normalScale'];
  if (params.metallicRoughnessMap !== undefined) material.metallicRoughnessMap = params.metallicRoughnessMap as MaterialState['metallicRoughnessMap'];
  if (params.roughnessMap !== undefined) material.roughnessMap = params.roughnessMap as MaterialState['roughnessMap'];
  if (params.metalnessMap !== undefined) material.metalnessMap = params.metalnessMap as MaterialState['metalnessMap'];
  if (params.transmissionMap !== undefined) material.transmissionMap = params.transmissionMap as MaterialState['transmissionMap'];
  if (params.thinFilmMap !== undefined) material.thinFilmMap = params.thinFilmMap as MaterialState['thinFilmMap'];
  if (params.shadowCatcher !== undefined) material.shadowCatcher = params.shadowCatcher as MaterialState['shadowCatcher'];
  if (params.unlit !== undefined) material.unlit = params.unlit as MaterialState['unlit'];
  if (params.bevelSize !== undefined) material.bevelSize = params.bevelSize as MaterialState['bevelSize'];
  if (params.mapAlphaUsage !== undefined) material.mapAlphaUsage = params.mapAlphaUsage as MaterialState['mapAlphaUsage'];
  if (params.uvProjection !== undefined) material.uvProjection = params.uvProjection as MaterialState['uvProjection'];
  if (params.uvProjectionScale !== undefined) material.uvProjectionScale = params.uvProjectionScale as MaterialState['uvProjectionScale'];
  if (params.displacementUvProjection !== undefined) material.displacementUvProjection = params.displacementUvProjection as MaterialState['displacementUvProjection'];
  if (params.displacementUvProjectionScale !== undefined) material.displacementUvProjectionScale = params.displacementUvProjectionScale as MaterialState['displacementUvProjectionScale'];
  if (params.displacementMap !== undefined) material.displacementMap = params.displacementMap as MaterialState['displacementMap'];
  if (params.displacementScale !== undefined) material.displacementScale = params.displacementScale as MaterialState['displacementScale'];
  if (params.displacementBias !== undefined) material.displacementBias = params.displacementBias as MaterialState['displacementBias'];
  if (params.displacementStepSize !== undefined) material.displacementStepSize = params.displacementStepSize as MaterialState['displacementStepSize'];
  if (params.thinFilmThicknessMinimum !== undefined) material.thinFilmThicknessMinimum = params.thinFilmThicknessMinimum as MaterialState['thinFilmThicknessMinimum'];
  if (params.thinFilmMapChannel !== undefined) material.thinFilmMapChannel = params.thinFilmMapChannel as MaterialState['thinFilmMapChannel'];
  if (params.coatWeightMap !== undefined) material.coatWeightMap = params.coatWeightMap as MaterialState['coatWeightMap'];
  if (params.coatRoughnessMap !== undefined) material.coatRoughnessMap = params.coatRoughnessMap as MaterialState['coatRoughnessMap'];
  if (params.fuzzColorMap !== undefined) material.fuzzColorMap = params.fuzzColorMap as MaterialState['fuzzColorMap'];
  if (params.fuzzRoughnessMap !== undefined) material.fuzzRoughnessMap = params.fuzzRoughnessMap as MaterialState['fuzzRoughnessMap'];
  if (params.specularWeightMap !== undefined) material.specularWeightMap = params.specularWeightMap as MaterialState['specularWeightMap'];
  if (params.specularColorMap !== undefined) material.specularColorMap = params.specularColorMap as MaterialState['specularColorMap'];
  if (params.anisotropyMap !== undefined) material.anisotropyMap = params.anisotropyMap as MaterialState['anisotropyMap'];
  if (params.specularAnisotropyRotation !== undefined) material.specularAnisotropyRotation = params.specularAnisotropyRotation as MaterialState['specularAnisotropyRotation'];
  if (params.coatAnisotropyRotation !== undefined) material.coatAnisotropyRotation = params.coatAnisotropyRotation as MaterialState['coatAnisotropyRotation'];
  if (params.specularAnisotropyModel !== undefined) material.specularAnisotropyModel = params.specularAnisotropyModel as MaterialState['specularAnisotropyModel'];
  if (params.coatNormalMap !== undefined) material.coatNormalMap = params.coatNormalMap as MaterialState['coatNormalMap'];
  if (params.coatNormalScale !== undefined) material.coatNormalScale = params.coatNormalScale as MaterialState['coatNormalScale'];
}
let textureId = 1;
const textureWeakMap = new WeakMap<TextureState, number>();
export function resetMaterialTextureId() { textureId = 1; }
function hashScalar(value: number | boolean | string | undefined): string {
  return value == null ? '$' : String(value);
}
function hashColor(value: import('../types.js').ColorRGB | undefined): string {
  return value == null ? '$' : [value[0], value[1], value[2]].join('_');
}
function hashVec2(value: import('../types.js').Vec2 | undefined): string {
  if (value == null) return '$';
  if (value instanceof Float32Array) {
    const values: number[] = [];
    for (let i = 0; i < value.length; i++) values.push(value[i]);
    return values.join('_');
  }
  return [value[0], value[1]].join('_');
}
function hashTexture(value: TextureState | undefined): string {
  if (!value) return '$';
  if (!textureWeakMap.has(value)) textureWeakMap.set(value, textureId++);
  return `${textureWeakMap.get(value)!}@${value.version}`;
}
export function getMaterialHashKey(material: MaterialState) {
  // Match schema order without constructing a heterogeneous native value union.
  return [
    hashScalar(material.baseWeight),
    hashColor(material.baseColor),
    hashScalar(material.baseDiffuseRoughness),
    hashScalar(material.baseMetalness),
    hashScalar(material.specularWeight),
    hashColor(material.specularColor),
    hashScalar(material.specularRoughness),
    hashScalar(material.specularIor),
    hashScalar(material.specularAnisotropy),
    hashScalar(material.transmissionWeight),
    hashColor(material.transmissionColor),
    hashScalar(material.transmissionDepth),
    hashColor(material.transmissionScatter),
    hashScalar(material.transmissionScatterAnisotropy),
    hashScalar(material.transmissionDispersionScale),
    hashScalar(material.transmissionDispersionAbbeNumber),
    hashScalar(material.subsurfaceWeight),
    hashColor(material.subsurfaceColor),
    hashScalar(material.subsurfaceRadius),
    hashColor(material.subsurfaceRadiusScale),
    hashScalar(material.subsurfaceAnisotropy),
    hashScalar(material.fuzzWeight),
    hashColor(material.fuzzColor),
    hashScalar(material.fuzzRoughness),
    hashScalar(material.coatWeight),
    hashColor(material.coatColor),
    hashScalar(material.coatRoughness),
    hashScalar(material.coatAnisotropy),
    hashScalar(material.coatIor),
    hashScalar(material.coatDarkening),
    hashScalar(material.thinFilmWeight),
    hashScalar(material.thinFilmThickness),
    hashScalar(material.thinFilmIor),
    hashColor(material.emissionColor),
    hashScalar(material.emissionLuminance),
    hashScalar(material.opacity),
    hashScalar(material.thinWalled),
    hashScalar(material.doubleSided),
    hashTexture(material.map),
    hashTexture(material.alphaMap),
    hashScalar(material.alphaMode),
    hashScalar(material.alphaCutoff),
    hashTexture(material.emissiveMap),
    hashTexture(material.normalMap),
    hashVec2(material.normalScale),
    hashTexture(material.metallicRoughnessMap),
    hashTexture(material.roughnessMap),
    hashTexture(material.metalnessMap),
    hashTexture(material.transmissionMap),
    hashTexture(material.thinFilmMap),
    hashScalar(material.shadowCatcher),
    hashScalar(material.unlit),
    hashScalar(material.bevelSize),
    hashScalar(material.mapAlphaUsage),
    hashScalar(material.uvProjection),
    hashVec2(material.uvProjectionScale),
    hashScalar(material.displacementUvProjection),
    hashScalar(material.displacementUvProjectionScale),
    hashTexture(material.displacementMap),
    hashScalar(material.displacementScale),
    hashScalar(material.displacementStepSize),
    hashScalar(material.thinFilmThicknessMinimum),
    hashScalar(material.thinFilmMapChannel),
    hashTexture(material.coatWeightMap),
    hashTexture(material.coatRoughnessMap),
    hashTexture(material.fuzzColorMap),
    hashTexture(material.fuzzRoughnessMap),
    hashTexture(material.specularWeightMap),
    hashTexture(material.specularColorMap),
    hashTexture(material.anisotropyMap),
    hashScalar(material.specularAnisotropyRotation),
    hashScalar(material.coatAnisotropyRotation),
    hashScalar(material.specularAnisotropyModel),
    hashTexture(material.coatNormalMap),
    hashVec2(material.coatNormalScale),
    hashScalar(material.displacementBias),
  ].join('_');
}
