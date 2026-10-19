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
      { kind: 'number', key: 'displacementScale', label: 'Scale', min: 0, max: 1, step: 0.001, texture: 'displacementMap' },
      { kind: 'number', key: 'displacementBias', label: 'Bias', min: -1, max: 1, step: 0.001 }
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

// Presets reset every layer and the shared specular settings, so a preset looks
// the same whatever material it is applied to. Textures and displacement stay.
const BASE: MaterialValues = {
  baseMetalness: 0, baseDiffuseRoughness: 0, specularWeight: 1, specularIor: 1.5, specularAnisotropy: 0,
  transmissionWeight: 0, transmissionColor: [1, 1, 1], transmissionDepth: 0, transmissionDispersionScale: 0, thinWalled: false,
  coatWeight: 0, coatRoughness: 0, coatIor: 1.6, coatColor: [1, 1, 1],
  subsurfaceWeight: 0, fuzzWeight: 0, thinFilmWeight: 0, emissionLuminance: 0, opacity: 1
};

export type MaterialPresetCategory = 'basic' | 'metal' | 'glass' | 'soft';

export const MATERIAL_PRESET_CATEGORIES: { value: MaterialPresetCategory; label: string }[] = [
  { value: 'basic', label: 'Basic' },
  { value: 'metal', label: 'Metal' },
  { value: 'glass', label: 'Glass' },
  { value: 'soft', label: 'Soft' }
];

export interface MaterialPreset {
  id: string;
  label: string;
  category: MaterialPresetCategory;
  values: MaterialValues;
}

const preset = (category: MaterialPresetCategory, id: string, label: string, values: MaterialValues): MaterialPreset =>
  ({ id, label, category, values: { ...BASE, ...values } });

// Metal colors are linear F0 reflectances of the pure metals.
export const MATERIAL_PRESETS: MaterialPreset[] = [
  preset('basic', 'white', 'White model', { baseColor: [1, 1, 1], specularRoughness: 0.8 }),
  preset('basic', 'plastic', 'Plastic', { baseColor: [0.05, 0.25, 0.7], specularRoughness: 0.32, specularIor: 1.46 }),
  preset('basic', 'clay', 'Clay', { baseColor: [0.5, 0.22, 0.12], specularRoughness: 0.9, baseDiffuseRoughness: 1 }),
  preset('basic', 'rubber', 'Rubber', { baseColor: [0.02, 0.02, 0.02], specularRoughness: 0.65, specularIor: 1.52 }),
  preset('basic', 'ceramic', 'Ceramic', { baseColor: [0.85, 0.85, 0.82], specularRoughness: 0.5, coatWeight: 1, coatRoughness: 0.03, coatIor: 1.5 }),
  preset('basic', 'carpaint', 'Car paint', { baseColor: [0.45, 0.02, 0.015], baseMetalness: 0.3, specularRoughness: 0.4, coatWeight: 1, coatRoughness: 0.02, coatIor: 1.5 }),
  preset('basic', 'pearl', 'Pearl paint', {
    baseColor: [0.8, 0.8, 0.82], baseMetalness: 0.4, specularRoughness: 0.35, coatWeight: 1, coatRoughness: 0.02, coatIor: 1.5,
    thinFilmWeight: 0.6, thinFilmThickness: 0.4, thinFilmIor: 1.5
  }),
  preset('basic', 'glow', 'Glow', { baseColor: [0.02, 0.02, 0.02], specularRoughness: 0.4, emissionColor: [1, 0.45, 0.15], emissionLuminance: 2 }),

  preset('metal', 'metal', 'Metal', { baseColor: [0.91, 0.92, 0.92], baseMetalness: 1, specularRoughness: 0.18 }),
  preset('metal', 'chrome', 'Chrome', { baseColor: [0.55, 0.556, 0.554], baseMetalness: 1, specularRoughness: 0.02 }),
  preset('metal', 'gold', 'Gold', { baseColor: [1, 0.71, 0.29], baseMetalness: 1, specularRoughness: 0.15 }),
  preset('metal', 'copper', 'Copper', { baseColor: [0.95, 0.64, 0.54], baseMetalness: 1, specularRoughness: 0.25 }),
  preset('metal', 'brass', 'Brass', { baseColor: [0.91, 0.78, 0.42], baseMetalness: 1, specularRoughness: 0.3 }),
  preset('metal', 'iron', 'Cast iron', { baseColor: [0.56, 0.57, 0.58], baseMetalness: 1, specularRoughness: 0.55 }),
  preset('metal', 'brushed', 'Brushed', { baseColor: [0.91, 0.92, 0.92], baseMetalness: 1, specularRoughness: 0.35, specularAnisotropy: 0.8 }),
  preset('metal', 'anodized', 'Anodized', {
    baseColor: [0.54, 0.5, 0.45], baseMetalness: 1, specularRoughness: 0.2, thinFilmWeight: 1, thinFilmThickness: 0.32, thinFilmIor: 2.2
  }),

  preset('glass', 'glass', 'Glass', { baseColor: [1, 1, 1], specularRoughness: 0, transmissionWeight: 1 }),
  preset('glass', 'frosted', 'Frosted', { baseColor: [1, 1, 1], specularRoughness: 0.35, transmissionWeight: 1 }),
  preset('glass', 'bottle', 'Bottle', { baseColor: [1, 1, 1], specularRoughness: 0, transmissionWeight: 1, transmissionColor: [0.2, 0.6, 0.25], transmissionDepth: 0.5 }),
  preset('glass', 'acrylic', 'Acrylic', { baseColor: [1, 1, 1], specularRoughness: 0.02, specularIor: 1.49, transmissionWeight: 1, transmissionColor: [0.9, 0.08, 0.05], transmissionDepth: 0.3 }),
  preset('glass', 'diamond', 'Diamond', { baseColor: [1, 1, 1], specularRoughness: 0, specularIor: 2.42, transmissionWeight: 1, transmissionDispersionScale: 1 }),
  preset('glass', 'water', 'Water', { baseColor: [1, 1, 1], specularRoughness: 0, specularIor: 1.33, transmissionWeight: 1, transmissionColor: [0.9, 0.97, 1], transmissionDepth: 2 }),
  preset('glass', 'honey', 'Honey', { baseColor: [1, 1, 1], specularRoughness: 0.05, transmissionWeight: 1, transmissionColor: [0.95, 0.6, 0.1], transmissionDepth: 0.6 }),
  preset('glass', 'soap', 'Bubble', {
    baseColor: [1, 1, 1], specularRoughness: 0, specularIor: 1.33, transmissionWeight: 1, thinWalled: true,
    thinFilmWeight: 1, thinFilmThickness: 0.45, thinFilmIor: 1.33
  }),

  preset('soft', 'skin', 'Skin', { baseColor: [0.8, 0.55, 0.45], specularRoughness: 0.45, specularIor: 1.4, subsurfaceWeight: 1, subsurfaceColor: [0.9, 0.6, 0.48], subsurfaceRadius: 0.2 }),
  preset('soft', 'wax', 'Wax', { baseColor: [0.85, 0.75, 0.55], specularRoughness: 0.35, specularIor: 1.45, subsurfaceWeight: 1, subsurfaceColor: [0.9, 0.75, 0.5], subsurfaceRadius: 0.3 }),
  preset('soft', 'jade', 'Jade', { baseColor: [0.1, 0.45, 0.2], specularRoughness: 0.15, specularIor: 1.66, subsurfaceWeight: 1, subsurfaceColor: [0.15, 0.6, 0.25], subsurfaceRadius: 0.5 }),
  preset('soft', 'marble', 'Marble', { baseColor: [0.85, 0.83, 0.8], specularRoughness: 0.2, subsurfaceWeight: 1, subsurfaceColor: [0.85, 0.83, 0.8], subsurfaceRadius: 0.15 }),
  preset('soft', 'milk', 'Milk', { baseColor: [0.95, 0.93, 0.88], specularRoughness: 0.1, specularIor: 1.35, subsurfaceWeight: 1, subsurfaceColor: [0.95, 0.93, 0.88], subsurfaceRadius: 0.6 }),
  preset('soft', 'velvet', 'Velvet', { baseColor: [0.06, 0.02, 0.12], specularRoughness: 0.8, fuzzWeight: 1, fuzzColor: [0.6, 0.45, 0.85], fuzzRoughness: 0.4 }),
  preset('soft', 'cotton', 'Cotton', {
    baseColor: [0.7, 0.68, 0.62], specularRoughness: 1, specularWeight: 0.5, baseDiffuseRoughness: 1, fuzzWeight: 1, fuzzColor: [1, 1, 1], fuzzRoughness: 0.8
  }),
  preset('soft', 'leather', 'Leather', { baseColor: [0.12, 0.045, 0.02], specularRoughness: 0.55, coatWeight: 0.4, coatRoughness: 0.35, coatIor: 1.5 })
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
