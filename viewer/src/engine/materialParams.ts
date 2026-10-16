import type { OpenPBRMaterial } from '@meimu/mutracer';

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

export type TextureKey = 'map' | 'metallicRoughnessMap' | 'roughnessMap' | 'metalnessMap' | 'emissiveMap' | 'transmissionMap' | 'normalMap' | 'thinFilmMap' | 'displacementMap';

/** Texture slots shown in the Textures section, with the channel each slot reads. */
export const TEXTURE_SLOTS: { key: TextureKey; label: string; hint: string }[] = [
  { key: 'map', label: 'Base color', hint: 'sRGB, multiplies Color' },
  { key: 'metallicRoughnessMap', label: 'Metal / rough', hint: 'G roughness, B metalness' },
  { key: 'roughnessMap', label: 'Roughness', hint: 'Green channel' },
  { key: 'metalnessMap', label: 'Metalness', hint: 'Blue channel' },
  { key: 'normalMap', label: 'Normal', hint: 'Tangent space' },
  { key: 'displacementMap', label: 'Displacement', hint: 'Red channel · WebGPU only' },
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
    id: 'displacement', label: 'Displacement', params: [
      { kind: 'number', key: 'displacementScale', label: 'Height', min: 0, max: 1, step: 0.001, texture: 'displacementMap' }
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

// Track hidden displacement settings for reset, undo and cached edits as well.
export const MATERIAL_KEYS = [...new Set([
  ...MATERIAL_GROUPS.flatMap((g) => g.params.map((p) => p.key)),
  'displacementStepSize', 'displacementUvProjection', 'displacementUvProjectionScale'
] as const)];
export type DisplacementProjection = OpenPBRMaterial['displacementUvProjection'];
export const DISPLACEMENT_PROJECTIONS: DisplacementProjection[] = ['none', 'triplanar', 'spherical', 'cylindrical'];
export type MaterialValues = Partial<Record<(typeof MATERIAL_KEYS)[number], number | boolean | [number, number, number] | DisplacementProjection>>;

export function readMaterial(material: OpenPBRMaterial): MaterialValues {
  const values: MaterialValues = {};
  const record = material as unknown as Record<string, unknown>;
  for (const key of MATERIAL_KEYS) {
    const value = record[key];
    values[key] = Array.isArray(value) ? (value.slice(0, 3) as [number, number, number]) : (value as MaterialValues[typeof key]);
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

const ZERO_LAYERS: MaterialValues = {
  baseMetalness: 0, transmissionWeight: 0, coatWeight: 0, subsurfaceWeight: 0, fuzzWeight: 0,
  thinFilmWeight: 0, emissionLuminance: 0, specularAnisotropy: 0, thinWalled: false
};

export interface MaterialPreset {
  id: string;
  label: string;
  values: MaterialValues;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: 'white', label: 'White model',
    values: { ...ZERO_LAYERS, baseColor: [1, 1, 1], specularRoughness: 0.8, specularIor: 1.5, specularWeight: 1, baseDiffuseRoughness: 0, opacity: 1 }
  },
  {
    id: 'metal', label: 'Metal',
    values: { ...ZERO_LAYERS, baseColor: [0.91, 0.92, 0.92], baseMetalness: 1, specularRoughness: 0.18 }
  },
  {
    id: 'glass', label: 'Glass',
    values: { ...ZERO_LAYERS, baseColor: [1, 1, 1], specularRoughness: 0, specularIor: 1.5, transmissionWeight: 1, transmissionColor: [1, 1, 1], transmissionDepth: 0 }
  },
  {
    id: 'carpaint', label: 'Car paint',
    values: { ...ZERO_LAYERS, baseColor: [0.45, 0.02, 0.015], baseMetalness: 0.3, specularRoughness: 0.4, coatWeight: 1, coatRoughness: 0.02, coatIor: 1.5 }
  },
  {
    id: 'velvet', label: 'Velvet',
    values: { ...ZERO_LAYERS, baseColor: [0.06, 0.02, 0.12], specularRoughness: 0.8, fuzzWeight: 1, fuzzColor: [0.6, 0.45, 0.85], fuzzRoughness: 0.4 }
  },
  {
    id: 'skin', label: 'Skin',
    values: { ...ZERO_LAYERS, baseColor: [0.8, 0.55, 0.45], specularRoughness: 0.45, specularIor: 1.4, subsurfaceWeight: 1, subsurfaceColor: [0.9, 0.6, 0.48], subsurfaceRadius: 0.2 }
  },
  {
    id: 'plastic', label: 'Plastic',
    values: { ...ZERO_LAYERS, baseColor: [0.05, 0.25, 0.7], specularRoughness: 0.32, specularIor: 1.46 }
  },
  {
    id: 'soap', label: 'Soap film',
    values: { ...ZERO_LAYERS, baseColor: [0.02, 0.02, 0.02], specularRoughness: 0.05, thinFilmWeight: 1, thinFilmThickness: 0.45, thinFilmIor: 1.33 }
  }
];

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
