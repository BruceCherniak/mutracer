import { MATERIAL_TEXTURE_NAMES, MATERIAL_TEXTURE_SLOTS, type MaterialTextureIndex } from './materialTextureSlots.js';
import { packMaterialBuffer } from './materialLayout.js';
import {createCanvas} from '../util/canvas.js';
import { mapAlphaUsageConstants } from './materialConstants.js';
// Portions adapted from ray-tracing-renderer@0.10.15
// (https://github.com/hoverinc/ray-tracing-renderer).
// Copyright (c) 2019 HOVER, MIT license; see LICENSES/RayTracingRenderer-MIT.txt.

import { ShadowCatcherMaterial, UnlitMaterial } from '../constants.js';
import { vec2 } from '../math.js';
import { materialEmission } from './materialEmission.js';
import {
  Texture2DArray as WebGLTexture2DArray,
  constants,
  Texture2D
} from './webgl.js';
import OpenPBRMaterial, {
  materialAlphaModeConstants,
  resolveMaterialAlphaMode
} from '../scene/OpenPBRMaterial.js';
import { ColorRGB } from '../types.js';
import { mergeTexturesFromMaterials } from './texturesFromMaterials.js';
import Texture, {
  isTextureDataSource,
  type TextureDataSource
} from '../scene/Texture.js';
import { commonNearestFloatProps, setDataTexture } from './dataTextureUtil.js';
import { SceneLight } from '../scene/Scene.js';

export const DEFAULT_MAX_TEXTURE_ARRAY_BYTES = 384 * 1024 * 1024;

export interface MaterialTableOptions {
  maxTextureArrayBytes?: number;
  maxTextureArrayLayers?: number;
  maxTextureDimension2D?: number;
}

export interface TextureAtlasStats {
  estimatedBytes: number;
  height: number;
  layers: number;
  packTimeMs: number;
  scale: number;
  sourcePixels: number;
  textureCount: number;
  width: number;
}

export const USE_TFDM_DISPLACEMENT =
  typeof window !== 'undefined' ? (window as any).USE_TFDM_DISPLACEMENT : false;

export function materialUsesMedium(material: OpenPBRMaterial): boolean {
  return !material.thinWalled && (
    (material.transmissionWeight > 0 && material.transmissionDepth > 0) ||
    material.subsurfaceWeight > 0
  );
}

export const uvProjectionConstants = {
  none: 0,
  spherical: 1,
  cylindrical: 2,
  triplanar: 3
};

interface AtlasPlacement {
  height: number;
  index: number;
  layer: number;
  width: number;
  x: number;
  y: number;
}

interface AtlasShelf {
  height: number;
  x: number;
  y: number;
}

interface AtlasPage {
  nextY: number;
  placements: AtlasPlacement[];
  shelves: AtlasShelf[];
}

/**
 * Packs material textures into a small 2D-array atlas.
 *
 * The input rectangles are sorted from tallest/largest to smallest, then
 * placed with a shelf allocator. Each atlas layer contains horizontal shelves;
 * a texture is inserted into the first shelf with enough remaining width, or a
 * new shelf is opened below the existing ones. A new array layer is allocated
 * only when none of the current layers has enough room.
 *
 * `makeTextureArray` first tries this packing at full resolution. If the result
 * exceeds the adapter layer limit or the configured memory budget, it performs
 * a binary search for the largest uniform scale that fits. This preserves full
 * resolution whenever packing alone is sufficient and degrades predictably on
 * constrained hardware.
 *
 * The returned placements keep the original logical texture indices. Shaders
 * use per-texture atlas metadata instead of treating the logical index as the
 * physical array layer.
 */
function packTextureAtlas(
  textures: Texture[],
  pageSize: number,
  scale: number
) {
  const pages: AtlasPage[] = [];
  const placements = new Array<AtlasPlacement>(textures.length);
  const items = textures
    .map((texture, index) => ({
      height: Math.max(1, Math.floor(texture.image.height * scale)),
      index,
      width: Math.max(1, Math.floor(texture.image.width * scale))
    }))
    .sort((a, b) => b.height - a.height || b.width - a.width);

  for (const item of items) {
    let placement: AtlasPlacement | undefined;
    for (let layer = 0; layer < pages.length && !placement; layer++) {
      const page = pages[layer];
      for (const shelf of page.shelves) {
        if (
          item.height <= shelf.height &&
          shelf.x + item.width <= pageSize
        ) {
          placement = {
            ...item,
            layer,
            x: shelf.x,
            y: shelf.y
          };
          shelf.x += item.width;
          break;
        }
      }
      if (!placement && page.nextY + item.height <= pageSize) {
        placement = {
          ...item,
          layer,
          x: 0,
          y: page.nextY
        };
        page.shelves.push({
          height: item.height,
          x: item.width,
          y: page.nextY
        });
        page.nextY += item.height;
      }
    }

    if (!placement) {
      const layer = pages.length;
      placement = { ...item, layer, x: 0, y: 0 };
      pages.push({
        nextY: item.height,
        placements: [],
        shelves: [{ height: item.height, x: item.width, y: 0 }]
      });
    }
    pages[placement.layer].placements.push(placement);
    placements[item.index] = placement;
  }

  return { pages, placements };
}

function createAtlasCanvas(width: number, height: number) {
  return createCanvas(width, height);
}

function createDataAtlasPage(
  width: number,
  height: number,
  page: ReturnType<typeof packTextureAtlas>['pages'][number],
  textures: Texture[]
): TextureDataSource {
  const data = new Uint8Array(width * height * 4);
  for (const placement of page.placements) {
    const texture = textures[placement.index];
    const source = texture.image;
    if (!isTextureDataSource(source) || !(source.data instanceof Uint8Array)) {
      throw new Error(
        'Native texture atlas pages require RGBA8 Uint8Array sources.'
      );
    }
    if (source.data.length !== source.width * source.height * 4) {
      throw new Error(
        'Native texture atlas RGBA8 source length does not match its dimensions.'
      );
    }
    for (let y = 0; y < placement.height; y++) {
      let sourceY = Math.min(
        source.height - 1,
        Math.floor(((y + 0.5) * source.height) / placement.height)
      );
      if (texture.flipY) sourceY = source.height - 1 - sourceY;
      for (let x = 0; x < placement.width; x++) {
        const sourceX = Math.min(
          source.width - 1,
          Math.floor(((x + 0.5) * source.width) / placement.width)
        );
        const sourceOffset = (sourceY * source.width + sourceX) * 4;
        const targetOffset = (
          (placement.y + y) * width + placement.x + x
        ) * 4;
        data.set(source.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
  }
  return { data, width, height };
}

function makeTextureArray(
  textures: Texture[],
  sRGB = false,
  options: MaterialTableOptions = {}
) {
  const packStart = performance.now();
  if (!textures.length) {
    return {
      mapInfo: [] as number[],
      mapTransform: [] as number[],
      mapUvChannel: [] as number[],
      stats: {
        estimatedBytes: 0,
        height: 1,
        layers: 0,
        packTimeMs: performance.now() - packStart,
        scale: 1,
        sourcePixels: 0,
        textureCount: 0,
        width: 1
      } satisfies TextureAtlasStats,
      texture: new WebGLTexture2DArray({
        width: 1,
        height: 1,
        sRGB,
        source: [],
        minFilter: constants.LINEAR,
        magFilter: constants.LINEAR,
        wrapS: constants.CLAMP_TO_EDGE,
        wrapT: constants.CLAMP_TO_EDGE
      })
    };
  }

  const dataBacked = textures.some((texture) =>
    isTextureDataSource(texture.image)
  );
  if (
    dataBacked &&
    textures.some((texture) => !isTextureDataSource(texture.image))
  ) {
    throw new Error(
      'Material texture atlases cannot mix DOM images and data-backed images.'
    );
  }

  const maxTextureArrayLayers = options.maxTextureArrayLayers ?? Infinity;
  const maxTextureDimension2D = options.maxTextureDimension2D ?? Infinity;
  const maxTextureArrayBytes =
    options.maxTextureArrayBytes ?? DEFAULT_MAX_TEXTURE_ARRAY_BYTES;
  const sourcePixels = textures.reduce(
    (sum, texture) => sum + texture.image.width * texture.image.height,
    0
  );
  const maxSourceDimension = textures.reduce(
    (max, texture) =>
      Math.max(max, texture.image.width, texture.image.height),
    1
  );
  const maxPageSizeFromBudget = Math.max(
    1,
    Math.floor(Math.sqrt(maxTextureArrayBytes / 4))
  );
  const pageSize = Math.max(
    1,
    Math.floor(
      Math.min(
        maxSourceDimension,
        maxTextureDimension2D,
        maxPageSizeFromBudget
      )
    )
  );
  const pageBytes = pageSize * pageSize * 4;
  const maxPageCount = Math.max(
    1,
    Math.min(
      maxTextureArrayLayers,
      Math.floor(maxTextureArrayBytes / pageBytes)
    )
  );
  const maxScale = Math.min(1, pageSize / maxSourceDimension);
  let packed = packTextureAtlas(textures, pageSize, maxScale);
  let scale = maxScale;

  if (packed.pages.length > maxPageCount) {
    let low = 0;
    let high = maxScale;
    let bestPacked: ReturnType<typeof packTextureAtlas> | undefined;
    let bestScale = 0;
    for (let i = 0; i < 14; i++) {
      const candidateScale = (low + high) / 2;
      const candidate = packTextureAtlas(
        textures,
        pageSize,
        candidateScale
      );
      if (candidate.pages.length <= maxPageCount) {
        low = candidateScale;
        bestScale = candidateScale;
        bestPacked = candidate;
      } else {
        high = candidateScale;
      }
    }
    if (!bestPacked) {
      throw new Error(
        `Unable to fit ${textures.length} textures into ${maxPageCount} atlas layers.`
      );
    }
    packed = bestPacked;
    scale = bestScale;
  }

  const atlasWidth = Math.max(
    1,
    ...packed.placements.map((placement) => placement.x + placement.width)
  );
  const atlasHeight = Math.max(
    1,
    ...packed.placements.map((placement) => placement.y + placement.height)
  );
  const pages = packed.pages.map((page) => {
    if (dataBacked) {
      return createDataAtlasPage(atlasWidth, atlasHeight, page, textures);
    }
    const canvas = createAtlasCanvas(atlasWidth, atlasHeight);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to create a canvas for the texture atlas.');
    }
    for (const placement of page.placements) {
      const sourceTexture = textures[placement.index];
      if (sourceTexture.flipY) {
        context.save();
        context.translate(placement.x, placement.y + placement.height);
        context.scale(1, -1);
        context.drawImage(
          sourceTexture.image as CanvasImageSource,
          0,
          0,
          placement.width,
          placement.height
        );
        context.restore();
      } else {
        context.drawImage(
          sourceTexture.image as CanvasImageSource,
          placement.x,
          placement.y,
          placement.width,
          placement.height
        );
      }
    }
    return canvas;
  });

  if (scale < 0.999) {
    console.warn(
      `Texture atlas downscaled to ${(scale * 100).toFixed(1)}% to fit the GPU budget.`
    );
  }

  // mapInfo = [uvScale.x, uvScale.y, layer + uvOffset.x, uvOffset.y].
  // Packing layer and X offset into one float keeps the shader metadata to one
  // vec4 per logical texture; floor(z) restores the layer and fract(z) the X.
  const mapInfo = packed.placements.flatMap((placement) => {
    const offsetX = (placement.x + 0.5) / atlasWidth;
    const offsetY = (placement.y + 0.5) / atlasHeight;
    return [
      Math.max(placement.width - 1, 0) / atlasWidth,
      Math.max(placement.height - 1, 0) / atlasHeight,
      placement.layer + offsetX,
      offsetY
    ];
  });

  const texture = new WebGLTexture2DArray({
    width: atlasWidth,
    height: atlasHeight,
    sRGB,
    source: pages,
    flipY: false,
    flipYArray: pages.map(() => false),
    minFilter: constants.LINEAR,
    magFilter: constants.LINEAR,
    wrapS: constants.CLAMP_TO_EDGE,
    wrapT: constants.CLAMP_TO_EDGE
  });

  return {
    texture,
    mapInfo,
    mapTransform: textures.flatMap((texture) => [
      texture.uvScale[0],
      texture.uvScale[1],
      texture.uvOffset[0],
      texture.uvOffset[1]
    ]),
    mapUvChannel: textures.map((texture) => texture.uvChannel),
    stats: {
      estimatedBytes: atlasWidth * atlasHeight * pages.length * 4,
      height: atlasHeight,
      layers: pages.length,
      packTimeMs: performance.now() - packStart,
      scale,
      sourcePixels,
      textureCount: textures.length,
      width: atlasWidth
    } satisfies TextureAtlasStats
  };
}

export interface BufferData extends Record<MaterialTextureIndex, number[]> {
  color: ColorRGB[];
  roughness: number[];
  metallic: number[];
  emission: ColorRGB[];
  ior: number[];
  transmission: number[];
  dispersion: number[];
  thinFilmThickness: number[];
  thinFilmIor: number[];
  anisotropy: number[];
  thin: number[];
  doubleSided: number[];
  bevelSize: number[];
  mapAlphaUsage: number[];

  normalScale: vec2.Vec2Array[];
  bumpStrength: number[];

  type: (typeof ShadowCatcherMaterial | typeof UnlitMaterial | 0)[];
  mapInfo: number[];
  mapTransform: number[];
  mapUvChannel: number[];

  bumpMapIndex: number[];

  mediumType: number[];
  mediumDensity: number[];
  mediumColor: ColorRGB[];

  uvProjection: number[];
  uvScale: vec2.Vec2Array[];

  displacementUvProjection: number[];
  displacementUvProjectionScale: number[];

  // For PDM displacement.
  displacementStepSize: number[];

  // For TFDM displacement.
  minmaxMapIndex: number[];
  minmaxMapSize: number[];
  // displacementScale: number[];

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

function clampColor(color: ArrayLike<number>, fallback = 0): ColorRGB {
  return [0, 1, 2].map((channel) => {
    const value = Number(color[channel]);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  }) as ColorRGB;
}

type OpenPbrMedium = {
  anisotropy: number;
  extinction: ColorRGB;
  scattering: ColorRGB;
};

function emptyOpenPbrMedium(): OpenPbrMedium {
  return {
    anisotropy: 0,
    extinction: [0, 0, 0],
    scattering: [0, 0, 0]
  };
}

function transmissionMedium(material: OpenPBRMaterial) {
  const weight = Math.min(1, Math.max(0, material.transmissionWeight));
  const depth = Math.max(0, material.transmissionDepth);
  if (weight <= 0 || depth <= 0 || material.thinWalled) return undefined;

  const color = clampColor(material.transmissionColor, 1);
  const scatterColor = clampColor(material.transmissionScatter);
  const extinction = color.map((channel) =>
    Math.max(0, -Math.log(Math.max(channel, 1e-6)) / depth)
  ) as ColorRGB;
  const scattering = scatterColor.map((channel, index) =>
    extinction[index] * channel
  ) as ColorRGB;
  return {
    anisotropy: Math.min(
      0.999,
      Math.max(-0.999, material.transmissionScatterAnisotropy)
    ),
    extinction,
    scattering
  } satisfies OpenPbrMedium;
}

function subsurfaceMedium(material: OpenPBRMaterial) {
  const weight = Math.min(1, Math.max(0, material.subsurfaceWeight));
  if (weight <= 0 || material.thinWalled) return undefined;

  // OpenPBR's radius is the extinction mean free path. The van de Hulst
  // mapping converts the artist-facing multiple-scattering color to a
  // single-scattering albedo while compensating for phase anisotropy.
  const radius = Math.max(material.subsurfaceRadius, 1e-3);
  const radiusScale = clampColor(material.subsurfaceRadiusScale, 1);
  const color = clampColor(material.subsurfaceColor);
  const anisotropy = Math.min(
    0.999,
    Math.max(-0.999, material.subsurfaceAnisotropy)
  );
  const extinction = radiusScale.map(
    (scale) => 1 / Math.max(radius * scale, 1e-3)
  ) as ColorRGB;
  const scattering = color.map((channel, index) => {
    const s = 4.09712 + 4.20863 * channel - Math.sqrt(
      9.59217 + 41.6808 * channel + 17.7126 * channel * channel
    );
    const sSquared = s * s;
    const albedo = Math.min(
      1,
      Math.max(0, (1 - sSquared) / (1 - anisotropy * sSquared))
    );
    return extinction[index] * albedo;
  }) as ColorRGB;
  return { anisotropy, extinction, scattering } satisfies OpenPbrMedium;
}

function combineOpenPbrMedia(
  material: OpenPBRMaterial,
  transmission: OpenPbrMedium | undefined,
  subsurface: OpenPbrMedium | undefined
) {
  const transmissionFraction = transmission
    ? Math.min(1, Math.max(0, material.transmissionWeight))
    : 0;
  const subsurfaceFraction = subsurface
    ? (1 - transmissionFraction)
      * Math.min(1, Math.max(0, material.subsurfaceWeight))
    : 0;
  const total = transmissionFraction + subsurfaceFraction;
  if (total <= 0) return undefined;

  const transmissionWeight = transmissionFraction / total;
  const subsurfaceWeight = subsurfaceFraction / total;
  const extinction = [0, 1, 2].map((channel) => {
    const transmissionAbsorption = transmission
      ? transmission.extinction[channel] - transmission.scattering[channel]
      : 0;
    const subsurfaceAbsorption = subsurface
      ? subsurface.extinction[channel] - subsurface.scattering[channel]
      : 0;
    const absorption = transmissionAbsorption * transmissionWeight
      + subsurfaceAbsorption * subsurfaceWeight;
    const scattering = (transmission?.scattering[channel] || 0)
        * transmissionWeight
      + (subsurface?.scattering[channel] || 0) * subsurfaceWeight;
    return Math.max(0, absorption + scattering);
  }) as ColorRGB;
  const scattering = [0, 1, 2].map((channel) =>
    (transmission?.scattering[channel] || 0) * transmissionWeight
      + (subsurface?.scattering[channel] || 0) * subsurfaceWeight
  ) as ColorRGB;
  const anisotropy = (transmission?.anisotropy || 0) * transmissionWeight
    + (subsurface?.anisotropy || 0) * subsurfaceWeight;
  return { anisotropy, extinction, scattering } satisfies OpenPbrMedium;
}

function openPbrMedium(material: OpenPBRMaterial) {
  const volume = combineOpenPbrMedia(
    material,
    transmissionMedium(material),
    subsurfaceMedium(material)
  );
  return volume ?? emptyOpenPbrMedium();
}

class MaterialTable {
  texture: WebGLTexture2DArray | undefined;
  textureAtlasStats: TextureAtlasStats;

  defines: Record<string, string | number> = {};

  bufferData: BufferData;

  private _matBufferTex = new Texture2D(commonNearestFloatProps);
  private _materialBufferColumnsLog: number = 0;

  private _displacementMaps: Texture[] = [];
  private _lightTexturesIndices: number[] = [];

  constructor(
    materials: OpenPBRMaterial[],
    lights: SceneLight[],
    options: MaterialTableOptions = {}
  ) {
    const maps = mergeTexturesFromMaterials(materials, MATERIAL_TEXTURE_NAMES);
    const bumpMapIndices = maps.indices.displacementMap.map((index, materialIndex) =>
      materials[materialIndex].displacementBumpStrength > 0 ? index : -1
    );
    // Displacement map must have the same width and height.
    // And it must be power of 2.
    const displacementMaps = (this._displacementMaps =
      maps.indices.displacementMap
        .map((idx) => {
          return maps.textures[idx];
        })
        .filter((a) => !!a));

    const bufferData = this._packParams(materials);

    const allTextures = maps.textures.slice();
    const lightTexturesIndices: number[] = [];
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i];
      if (light.type === 'RectLight' && light.texture) {
        lightTexturesIndices.push(allTextures.length);
        allTextures.push(light.texture);
      } else {
        lightTexturesIndices.push(-1);
      }
    }
    const { mapInfo, mapTransform, mapUvChannel, stats, texture } = makeTextureArray(
      allTextures,
      false,
      options
    );

    this.texture = texture;
    this.textureAtlasStats = stats;
    bufferData.mapInfo = mapInfo;
    bufferData.mapTransform = mapTransform;
    bufferData.mapUvChannel = mapUvChannel;
    for (const slot of MATERIAL_TEXTURE_SLOTS) {
      bufferData[slot.index] = maps.indices[slot.property];
    }
    bufferData.bumpMapIndex = bumpMapIndices;

    // min max map for tfdm displacement
    bufferData.minmaxMapIndex = USE_TFDM_DISPLACEMENT
        ? materials.map((m) =>
            m.displacementMap ? displacementMaps.indexOf(m.displacementMap) : -1
          )
        : [];
    bufferData.minmaxMapSize = USE_TFDM_DISPLACEMENT
        ? materials.map((m) => m.displacementMap?.image.width || 0)
        : [];

    this.bufferData = bufferData;

    this._lightTexturesIndices = lightTexturesIndices;

    function countMaps(indices: number[]) {
      return indices.filter((idx) => idx >= 0).length;
    }

    this.defines = {
      NUM_MAPS: allTextures.length,
      ...Object.fromEntries(MATERIAL_TEXTURE_SLOTS.flatMap(slot => slot.define
        ? [[slot.define, countMaps(maps.indices[slot.property])]] : [])),
      NUM_BUMP_MAPS: countMaps(bumpMapIndices)
    };

    this._updateBuffer();
  }

  private _packParams(materials: OpenPBRMaterial[]) {
    const media = materials.map(openPbrMedium);
    return {
      color: materials.map((m) => m.baseColor.slice(0, 3) as ColorRGB),
      roughness: materials.map((m) => m.specularRoughness),
      emission: materials.map(materialEmission),
      metallic: materials.map((m) => m.baseMetalness),
      ior: materials.map((m) => m.specularIor),
      dispersion: materials.map((m) => m.transmissionDispersionScale),
      thin: materials.map((m) => +m.thinWalled),
      bevelSize: materials.map((m) => m.bevelSize),
      transmission: materials.map((m) => m.transmissionWeight),
      anisotropy: materials.map((m) => m.specularAnisotropy),
      thinFilmThickness: materials.map((m) => m.thinFilmThickness),
      thinFilmIor: materials.map((m) => m.thinFilmIor),
      normalScale: materials.map((m) => m.normalScale),
      bumpStrength: materials.map((m) => Math.max(0, m.displacementBumpStrength)),
      mapAlphaUsage: materials.map((m) => mapAlphaUsageConstants[m.mapAlphaUsage]),
      type: materials.map((m) => {
        if (m.shadowCatcher) {
          return ShadowCatcherMaterial;
        }
        if (m.unlit) {
          return UnlitMaterial;
        }
        // Standard material
        return 0;
      }),
      // These slots are retained in the packed ABI for shader alignment.
      mediumType: materials.map((m) => Number(materialUsesMedium(m))),
      mediumDensity: materials.map(() => 0),
      mediumColor: materials.map(() => [0, 0, 0] as ColorRGB),
      uvProjection: materials.map(
        (m) => uvProjectionConstants[m.uvProjection] || 0
      ),
      uvScale: materials.map((m) => m.uvProjectionScale || [1, 1]),

      displacementUvProjection: materials.map(
        (m) => uvProjectionConstants[m.displacementUvProjection] || 0
      ),
      displacementUvProjectionScale: materials.map((m) => m.displacementUvProjectionScale || 1),
      displacementStepSize: materials.map(
        (m) => m.displacementStepSize || 0.01
      ),

      // Alpha
      alpha: materials.map((m) => m.opacity),
      alphaMode: materials.map(
        (m) => materialAlphaModeConstants[resolveMaterialAlphaMode(m)]
      ),
      alphaCutoff: materials.map((m) => Math.max(0, m.alphaCutoff)),
      doubleSided: materials.map((m) => Number(m.doubleSided)),

      baseWeight: materials.map((m) => m.baseWeight),
      baseDiffuseRoughness: materials.map((m) => m.baseDiffuseRoughness),
      specularWeight: materials.map((m) => m.specularWeight),
      specularColor: materials.map((m) => clampColor(m.specularColor, 1)),
      transmissionColor: materials.map((m) => clampColor(m.transmissionColor, 1)),
      transmissionDepth: materials.map((m) => Math.max(0, m.transmissionDepth)),
      transmissionScatter: materials.map((m) => clampColor(m.transmissionScatter)),
      transmissionScatterAnisotropy: materials.map((m) => m.transmissionScatterAnisotropy),
      subsurfaceWeight: materials.map((m) => m.subsurfaceWeight),
      subsurfaceColor: materials.map((m) => clampColor(m.subsurfaceColor)),
      subsurfaceRadius: materials.map((m) => Math.max(0, m.subsurfaceRadius)),
      subsurfaceRadiusScale: materials.map((m) => clampColor(m.subsurfaceRadiusScale)),
      subsurfaceScatterAnisotropy: materials.map((m) => m.subsurfaceAnisotropy),
      fuzzWeight: materials.map((m) => m.fuzzWeight),
      fuzzColor: materials.map((m) => clampColor(m.fuzzColor, 1)),
      fuzzRoughness: materials.map((m) => m.fuzzRoughness),
      coatWeight: materials.map((m) => m.coatWeight),
      coatColor: materials.map((m) => clampColor(m.coatColor, 1)),
      coatRoughness: materials.map((m) => m.coatRoughness),
      coatAnisotropy: materials.map((m) => m.coatAnisotropy),
      coatIor: materials.map((m) => m.coatIor),
      coatDarkening: materials.map((m) => m.coatDarkening),
      thinFilmWeight: materials.map((m) => m.thinFilmWeight),
      dispersionAbbeNumber: materials.map((m) => m.transmissionDispersionAbbeNumber),
      mediumExtinction: media.map((medium) => medium.extinction),
      mediumScattering: media.map((medium) => medium.scattering),
      mediumAnisotropy: media.map((medium) => medium.anisotropy),

    } as BufferData;
  }

  /** Repack parameters with the same material slots and unchanged texture metadata. */
  repackParams(materials: OpenPBRMaterial[]) {
    Object.assign(this.bufferData, this._packParams(materials));
    this._updateBuffer();
  }

  getBufferArray() {
    return packMaterialBuffer(this.bufferData, USE_TFDM_DISPLACEMENT);
  }

  getDisplacementMaps() {
    return this._displacementMaps;
  }

  getLightTexturesIndices() {
    return this._lightTexturesIndices;
  }

  private _updateBuffer() {
    this._materialBufferColumnsLog = setDataTexture(
      this._matBufferTex,
      this.getBufferArray(),
      4
    ).columnsLog;
  }

  setToPass(pass: {
    setUniform(label: string, value: unknown): unknown;
    setUniforms(values: Record<string, unknown>): void;
  }) {
    pass.setUniform('map', this.texture || null);
    pass.setUniform('mapInfo', this.bufferData.mapInfo);
    pass.setUniform('mapTransform', this.bufferData.mapTransform);
    pass.setUniform('mapUvChannel', this.bufferData.mapUvChannel);
    pass.setUniforms({
      materialBuffer: this._matBufferTex,
      materialBufferColumns: this._materialBufferColumnsLog
    });
  }

  dispose(gl: WebGL2RenderingContext) {
    this.texture?.dispose(gl);
    this._matBufferTex.dispose(gl);
  }
}

export default MaterialTable;
