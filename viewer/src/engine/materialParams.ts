import type { OpenPBRMaterial } from '@meimu/mutracer';
import presets from './material-presets.json' with { type: 'json' };

type NumberKey = {
  [K in keyof OpenPBRMaterial]-?: OpenPBRMaterial[K] extends number ? K : never
}[keyof OpenPBRMaterial];
type ColorKey = {
  [K in keyof OpenPBRMaterial]-?: OpenPBRMaterial[K] extends [number, number, number] ? K : never
}[keyof OpenPBRMaterial];
type BooleanKey = {
  [K in keyof OpenPBRMaterial]-?: OpenPBRMaterial[K] extends boolean ? K : never
}[keyof OpenPBRMaterial];

export type MaterialParam =
  | { kind: 'number'; key: NumberKey; label: string; min: number; max: number; step?: number; unit?: string; texture?: TextureKey }
  | { kind: 'color'; key: ColorKey; label: string; texture?: TextureKey }
  | { kind: 'boolean'; key: BooleanKey; label: string };

export type TextureKey = 'map' | 'metallicRoughnessMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap' | 'transmissionMap' | 'normalMap' | 'thinFilmMap';

/** Texture slots shown in the Textures section, with the channel each slot reads. */
export const TEXTURE_SLOTS: { key: TextureKey; label: string; hint: string }[] = [
  { key: 'map', label: 'Base color', hint: 'sRGB, multiplies Color' },
  { key: 'metallicRoughnessMap', label: 'Metal / rough', hint: 'G roughness, B metalness' },
  { key: 'roughnessMap', label: 'Roughness', hint: 'Green channel' },
  { key: 'metalnessMap', label: 'Metalness', hint: 'Blue channel' },
  { key: 'normalMap', label: 'Normal', hint: 'Tangent space' },
  { key: 'emissiveMap', label: 'Emission', hint: 'Multiplies emission color' },
  { key: 'transmissionMap', label: 'Transmission', hint: 'Red channel' },
  { key: 'thinFilmMap', label: 'Thin film', hint: 'Thickness' }
];
export const TEXTURE_KEYS = TEXTURE_SLOTS.map((slot) => slot.key);

export interface MaterialGroup {
  id: string;
  label: string;
  /** A weight that, at 0, collapses the group. */
  weight?: NumberKey;
  params: MaterialParam[];
}

export const MATERIAL_GROUPS: MaterialGroup[] = [
  {
    id: 'base', label: 'Base', params: [
      { kind: 'color', key: 'baseColor', label: 'Color', texture: 'map' },
      { kind: 'number', key: 'baseMetalness', label: 'Metalness', min: 0, max: 1, texture: 'metallicRoughnessMap' },
      { kind: 'number', key: 'specularRoughness', label: 'Roughness', min: 0, max: 1, texture: 'metallicRoughnessMap' },
      { kind: 'number', key: 'specularIor', label: 'IOR', min: 1, max: 3 }
    ]
  },
  {
    id: 'transmission', label: 'Transmission', weight: 'transmissionWeight', params: [
      { kind: 'number', key: 'transmissionWeight', label: 'Weight', min: 0, max: 1, texture: 'transmissionMap' },
      { kind: 'color', key: 'transmissionColor', label: 'Color' },
      { kind: 'number', key: 'transmissionDepth', label: 'Depth', min: 0, max: 5, unit: 'm' },
      { kind: 'number', key: 'transmissionDispersionScale', label: 'Dispersion', min: 0, max: 1 },
      { kind: 'boolean', key: 'thinWalled', label: 'Thin walled' }
    ]
  },
  {
    id: 'coat', label: 'Coat', weight: 'coatWeight', params: [
      { kind: 'number', key: 'coatWeight', label: 'Weight', min: 0, max: 1 },
      { kind: 'number', key: 'coatRoughness', label: 'Roughness', min: 0, max: 1 },
      { kind: 'number', key: 'coatIor', label: 'IOR', min: 1, max: 3 },
      { kind: 'color', key: 'coatColor', label: 'Tint' }
    ]
  },
  {
    id: 'subsurface', label: 'Subsurface', weight: 'subsurfaceWeight', params: [
      { kind: 'number', key: 'subsurfaceWeight', label: 'Weight', min: 0, max: 1 },
      { kind: 'color', key: 'subsurfaceColor', label: 'Color' },
      { kind: 'number', key: 'subsurfaceRadius', label: 'Radius', min: 0, max: 2 }
    ]
  },
  {
    id: 'fuzz', label: 'Fuzz', weight: 'fuzzWeight', params: [
      { kind: 'number', key: 'fuzzWeight', label: 'Weight', min: 0, max: 1 },
      { kind: 'color', key: 'fuzzColor', label: 'Color' },
      { kind: 'number', key: 'fuzzRoughness', label: 'Roughness', min: 0, max: 1 }
    ]
  },
  {
    id: 'thinFilm', label: 'Thin film', weight: 'thinFilmWeight', params: [
      { kind: 'number', key: 'thinFilmWeight', label: 'Weight', min: 0, max: 1 },
      { kind: 'number', key: 'thinFilmThickness', label: 'Thickness', min: 0, max: 2, unit: 'µm', texture: 'thinFilmMap' },
      { kind: 'number', key: 'thinFilmIor', label: 'IOR', min: 1, max: 3 }
    ]
  },
  {
    id: 'emission', label: 'Emission', weight: 'emissionLuminance', params: [
      { kind: 'color', key: 'emissionColor', label: 'Color', texture: 'emissiveMap' },
      { kind: 'number', key: 'emissionLuminance', label: 'Luminance', min: 0, max: 50 }
    ]
  },
  {
    id: 'advanced', label: 'Advanced', params: [
      { kind: 'number', key: 'specularAnisotropy', label: 'Anisotropy', min: 0, max: 1 },
      { kind: 'number', key: 'baseDiffuseRoughness', label: 'Diffuse roughness', min: 0, max: 1 },
      { kind: 'number', key: 'specularWeight', label: 'Specular weight', min: 0, max: 1 },
      { kind: 'number', key: 'opacity', label: 'Opacity', min: 0, max: 1 },
      { kind: 'number', key: 'bevelSize', label: 'Bevel', min: 0, max: 0.05, step: 0.001 },
      { kind: 'boolean', key: 'doubleSided', label: 'Double sided' }
    ]
  }
];

export const MATERIAL_KEYS = [...new Set(MATERIAL_GROUPS.flatMap((g) => g.params.map((p) => p.key)))];
export type MaterialValues = Partial<Record<(typeof MATERIAL_KEYS)[number], number | boolean | [number, number, number]>>;

export function readMaterial(material: OpenPBRMaterial): MaterialValues {
  const values: MaterialValues = {};
  const record = material as unknown as Record<string, unknown>;
  for (const key of MATERIAL_KEYS) {
    const value = record[key];
    values[key] = Array.isArray(value) ? (value.slice(0, 3) as [number, number, number]) : (value as number | boolean);
  }
  return values;
}

/** Whether two material values are equal, comparing colors element-wise. */
export function sameValue(a: MaterialValues[keyof MaterialValues], b: MaterialValues[keyof MaterialValues]) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}

export function writeMaterial(material: OpenPBRMaterial, values: MaterialValues) {
  const record = material as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    record[key] = Array.isArray(value) ? [...value] : value;
  }
}

/** Which texture slots a material uses, for the "multiplied by texture" marks. */
export function textureSlots(material: OpenPBRMaterial) {
  const record = material as unknown as Record<string, unknown>;
  const slots = new Set<TextureKey>();
  for (const key of TEXTURE_KEYS) {
    if (record[key]) slots.add(key);
  }
  if (slots.has('roughnessMap') || slots.has('metalnessMap')) slots.add('metallicRoughnessMap');
  return slots;
}

export interface MaterialPreset {
  id: string;
  label: string;
  values: MaterialValues;
}

export const MATERIAL_PRESETS = presets as MaterialPreset[];

// sRGB <-> linear for color pickers; OpenPBR colors are linear.
const toSRGB = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function linearToHex(color: [number, number, number]) {
  return '#' + color.map((c) => Math.round(Math.min(1, Math.max(0, toSRGB(c))) * 255).toString(16).padStart(2, '0')).join('');
}

export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => toLinear(c / 255)) as [number, number, number];
}
