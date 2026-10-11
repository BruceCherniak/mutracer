import { vec2 } from '../math.js';
import { ColorRGB } from '../types.js';
import Texture from './Texture.js';

export type UVProjection = 'none' | 'triplanar' | 'spherical' | 'cylindrical';
export type MaterialAlphaMode = 'auto' | 'opaque' | 'mask' | 'blend';

export type MaterialTextureName =
  | 'map'
  | 'alphaMap'
  | 'normalMap'
  | 'emissiveMap'
  | 'metallicRoughnessMap'
  | 'roughnessMap'
  | 'metalnessMap'
  | 'transmissionMap'
  | 'thinFilmMap'
  | 'displacementMap';

/**
 * OpenPBR 1.1 surface material.
 *
 * Property names are camel-case spellings of the OpenPBR inputs
 * (https://academysoftwarefoundation.github.io/OpenPBR/). Colors are linear
 * RGB. Length-valued inputs (`transmissionDepth`, `subsurfaceRadius`) use
 * scene units; `thinFilmThickness` is in micrometres as in OpenPBR.
 *
 * ```ts
 * const gold = new OpenPBRMaterial();
 * gold.baseColor = [1.0, 0.78, 0.34];
 * gold.baseMetalness = 1;
 * gold.specularRoughness = 0.2;
 * ```
 *
 * After changing a material that is already being rendered, call
 * `material.markUpdated()`.
 */
export default class OpenPBRMaterial {
  /** Incremented by markUpdated(). Default `0`. */
  version = 0;

  /** Call after changing any property of this material in place. */
  markUpdated(): this {
    this.version++;
    return this;
  }

  // Base
  /** Base layer weight. Default `1`. */
  baseWeight = 1;
  /** Diffuse/metal color. Default `[0.8, 0.8, 0.8]`. */
  baseColor: ColorRGB = [0.8, 0.8, 0.8];
  /** Oren-Nayar style roughness of the diffuse lobe. Default `0`. */
  baseDiffuseRoughness = 0;
  /** `0` dielectric, `1` metal. Default `0`. */
  baseMetalness = 0;

  // Specular
  /** Specular reflection weight. Default `1`. */
  specularWeight = 1;
  /** Specular tint. Default `[1, 1, 1]`. */
  specularColor: ColorRGB = [1, 1, 1];
  /** Microfacet roughness, `0` mirror to `1` rough. Default `0.3`. */
  specularRoughness = 0.3;
  /** Index of refraction. Default `1.5`. */
  specularIor = 1.5;
  /** Specular anisotropy (requires tangents). Default `0`. */
  specularAnisotropy = 0;

  // Transmission
  /** `1` makes the dielectric base fully transmissive (glass). Default `0`. */
  transmissionWeight = 0;
  /** Transmission tint, or the medium color at `transmissionDepth`. Default `[1, 1, 1]`. */
  transmissionColor: ColorRGB = [1, 1, 1];
  /** Depth at which `transmissionColor` is reached; `0` tints at the surface. Default `0`. */
  transmissionDepth = 0;
  /** Volume scattering color of the transmissive medium. Default `[0, 0, 0]`. */
  transmissionScatter: ColorRGB = [0, 0, 0];
  /** Henyey-Greenstein anisotropy of the medium, -1 to 1. Default `0`. */
  transmissionScatterAnisotropy = 0;
  /** Dispersion strength; `> 0` enables spectral rendering. Default `0`. */
  transmissionDispersionScale = 0;
  /** Abbe number controlling dispersion. Default `20`. */
  transmissionDispersionAbbeNumber = 20;

  // Subsurface
  /** Subsurface scattering weight. Default `0`. */
  subsurfaceWeight = 0;
  /** Subsurface color. Default `[0.8, 0.8, 0.8]`. */
  subsurfaceColor: ColorRGB = [0.8, 0.8, 0.8];
  /** Mean free path in scene units. Default `1`. */
  subsurfaceRadius = 1;
  /** Per-channel multiplier of `subsurfaceRadius`. Default `[1, 0.5, 0.25]`. */
  subsurfaceRadiusScale: ColorRGB = [1, 0.5, 0.25];
  /** Scattering anisotropy, -1 to 1. Default `0`. */
  subsurfaceAnisotropy = 0;

  // Fuzz (sheen)
  /** Fuzz (sheen) layer weight. Default `0`. */
  fuzzWeight = 0;
  /** Fuzz color. Default `[1, 1, 1]`. */
  fuzzColor: ColorRGB = [1, 1, 1];
  /** Fuzz roughness. Default `0.5`. */
  fuzzRoughness = 0.5;

  // Coat
  /** Clear coat weight. Default `0`. */
  coatWeight = 0;
  /** Coat absorption color. Default `[1, 1, 1]`. */
  coatColor: ColorRGB = [1, 1, 1];
  /** Coat roughness. Default `0`. */
  coatRoughness = 0;
  /** Coat anisotropy. Default `0`. */
  coatAnisotropy = 0;
  /** Coat index of refraction. Default `1.6`. */
  coatIor = 1.6;
  /** How much the coat darkens and saturates the base. Default `1`. */
  coatDarkening = 1;

  // Thin film
  /** Thin-film interference weight (iridescence). Default `0`. */
  thinFilmWeight = 0;
  /** Film thickness in micrometres. Default `0.5`. */
  thinFilmThickness = 0.5;
  /** Film index of refraction. Default `1.4`. */
  thinFilmIor = 1.4;

  // Emission and geometry
  /** Emission color. Default `[1, 1, 1]`. */
  emissionColor: ColorRGB = [1, 1, 1];
  /** Emitted radiance scale; `0` disables emission. Default `0`. */
  emissionLuminance = 0;
  /** Coverage, `1` opaque. See `alphaMode`. Default `1`. */
  opacity = 1;
  /** Treat the surface as an infinitely thin shell (leaves, paper). Default `false`. */
  thinWalled = false;
  /** Disables geometric back-face culling for this material. Default `false`. */
  doubleSided = false;

  // Textures
  /** Base color texture (sRGB), multiplied with `baseColor`. */
  map?: Texture;
  /** Standalone opacity texture sampled from its green channel, matching Three.js. */
  alphaMap?: Texture;
  /** Opacity interpretation; `auto` derives the mode from the alpha inputs. Default `auto`. */
  alphaMode: MaterialAlphaMode = 'auto';
  /** Alpha-test threshold for `mask` mode. Default `0`. */
  alphaCutoff = 0;
  /** Emission texture multiplied with `emissionColor`. */
  emissiveMap?: Texture;
  /** Tangent-space normal map. */
  normalMap?: Texture;
  /** Normal map strength per axis. Default `[1, 1]`. */
  normalScale: vec2.Vec2Array = [1, 1];
  /** glTF-compatible B=metalness, G=specular roughness texture. */
  metallicRoughnessMap?: Texture;
  /** Standalone roughness texture sampled from its green channel. */
  roughnessMap?: Texture;
  /** Standalone metalness texture sampled from its blue channel. */
  metalnessMap?: Texture;
  /** Multiplies transmission weight using the texture's red channel. */
  transmissionMap?: Texture;
  /** Thin-film thickness texture. */
  thinFilmMap?: Texture;

  // Renderer extensions
  /**
   * Invisible ground that only receives shadows, composited over the
   * background. Default `false`.
   */
  shadowCatcher = false;
  /** Displays emission without scattering or illuminating other surfaces. Default `false`. */
  unlit = false;
  /** Radius of rounded-edge shading (shader bevel) in scene units. `0` disables it. Default `0`. */
  bevelSize = 0;
  /** How `map`'s alpha is used; see the `mapAlphaUsage*` constants. Default opaque. */
  mapAlphaUsage = 0;
  /** Procedural UV projection for textures without (good) UVs. Default `none`. */
  uvProjection: UVProjection = 'none';
  /** UV scale used with `uvProjection`. Default `[1, 1]`. */
  uvScale: vec2.Vec2Array = [1, 1];

  // Displacement
  /** Height texture (red channel) for displacement. */
  displacementMap?: Texture;
  /** Procedural UV projection for the displacement map. Default `none`. */
  displacementUvProjection: UVProjection = 'none';
  /** UV scale used with `displacementUvProjection`. Default `1`. */
  displacementUvScale = 1;
  /** Height multiplier in mesh-local coordinate units. Default `0.1`. */
  displacementScale = 0.1;
  /** Ray-marching step for projective displacement. Default `0.01`. */
  displacementStepSize = 0.01;
  /** Reuses the displacement height map as a shading-only bump map. Default `0`. */
  displacementBumpStrength = 0;

  /** `mapAlphaUsage`: ignore the alpha channel of `map`. */
  static mapAlphaUsageOpaque = 0;
  /** `mapAlphaUsage`: use the alpha channel of `map` as opacity. */
  static mapAlphaUsageAlpha = 2;
  /** `mapAlphaUsage`: use the alpha channel of `map` as transmission. */
  static mapAlphaUsageTransmission = 3;
}
export const materialAlphaModeConstants = {
  opaque: 0,
  mask: 1,
  blend: 2
} as const;

export type ResolvedMaterialAlphaMode = Exclude<MaterialAlphaMode, 'auto'>;

export function resolveMaterialAlphaMode(
  material: OpenPBRMaterial
): ResolvedMaterialAlphaMode {
  if (material.alphaMode !== 'auto') return material.alphaMode;
  if (material.alphaCutoff > 0) return 'mask';
  if (
    material.opacity < 1 ||
    material.mapAlphaUsage === OpenPBRMaterial.mapAlphaUsageAlpha ||
    material.alphaMap
  ) {
    return 'blend';
  }
  return 'opaque';
}

export const materialKeys: (keyof OpenPBRMaterial)[] = [
  'baseWeight', 'baseColor', 'baseDiffuseRoughness', 'baseMetalness',
  'specularWeight', 'specularColor', 'specularRoughness', 'specularIor',
  'specularAnisotropy', 'transmissionWeight', 'transmissionColor',
  'transmissionDepth', 'transmissionScatter',
  'transmissionScatterAnisotropy', 'transmissionDispersionScale',
  'transmissionDispersionAbbeNumber', 'subsurfaceWeight', 'subsurfaceColor',
  'subsurfaceRadius', 'subsurfaceRadiusScale', 'subsurfaceAnisotropy',
  'fuzzWeight', 'fuzzColor', 'fuzzRoughness', 'coatWeight', 'coatColor',
  'coatRoughness', 'coatAnisotropy', 'coatIor', 'coatDarkening',
  'thinFilmWeight', 'thinFilmThickness', 'thinFilmIor', 'emissionColor',
  'emissionLuminance', 'opacity', 'thinWalled', 'doubleSided', 'map', 'alphaMap',
  'alphaMode', 'alphaCutoff', 'emissiveMap',
  'normalMap', 'normalScale', 'metallicRoughnessMap', 'roughnessMap',
  'metalnessMap', 'transmissionMap', 'thinFilmMap',
  'shadowCatcher', 'unlit', 'bevelSize', 'mapAlphaUsage', 'uvProjection', 'uvScale',
  'displacementUvProjection', 'displacementUvScale', 'displacementMap',
  'displacementScale', 'displacementStepSize', 'displacementBumpStrength',
];

export const materialTextureKeys = [
  'map', 'alphaMap', 'emissiveMap', 'normalMap', 'metallicRoughnessMap', 'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'displacementMap', 'displacementBumpStrength'
] as const satisfies readonly (keyof OpenPBRMaterial)[];

export const materialGeometryKeys = [
  'displacementUvProjection', 'displacementUvScale', 'displacementScale', 'displacementStepSize'
] as const satisfies readonly (keyof OpenPBRMaterial)[];

export const materialParamKeys = [
  'baseWeight', 'baseColor', 'baseDiffuseRoughness', 'baseMetalness', 'specularWeight', 'specularColor', 'specularRoughness', 'specularIor', 'specularAnisotropy', 'transmissionWeight', 'transmissionColor', 'transmissionDepth', 'transmissionScatter', 'transmissionScatterAnisotropy', 'transmissionDispersionScale', 'transmissionDispersionAbbeNumber', 'subsurfaceWeight', 'subsurfaceColor', 'subsurfaceRadius', 'subsurfaceRadiusScale', 'subsurfaceAnisotropy', 'fuzzWeight', 'fuzzColor', 'fuzzRoughness', 'coatWeight', 'coatColor', 'coatRoughness', 'coatAnisotropy', 'coatIor', 'coatDarkening', 'thinFilmWeight', 'thinFilmThickness', 'thinFilmIor', 'emissionColor', 'emissionLuminance', 'opacity', 'thinWalled', 'doubleSided', 'alphaMode', 'alphaCutoff', 'normalScale', 'shadowCatcher', 'unlit', 'bevelSize', 'mapAlphaUsage', 'uvProjection', 'uvScale'
] as const satisfies readonly (keyof OpenPBRMaterial)[];

let textureId = 1;
const textureWeakMap = new WeakMap<Texture, number>();

export function resetMaterialTextureId() { textureId = 1; }

export function getMaterialHashKey(material: OpenPBRMaterial) {
  return materialKeys.map((key) => {
    const value = material[key];
    if (value == null) return '$';
    if (value instanceof Texture) {
      if (!textureWeakMap.has(value)) textureWeakMap.set(value, textureId++);
      return `${textureWeakMap.get(value)!}@${value.version}`;
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && 'length' in value) {
      return Array.from(value as ArrayLike<number>).join('_');
    }
    return value;
  }).join('_');
}
