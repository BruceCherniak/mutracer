import { afterEach, describe, expect, it, vi } from 'vitest';
import MergedMaterialData, {
  
  
} from '../../src/renderer/MergedMaterialData';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import { UnlitMaterial } from '../../src/constants';

describe('MergedMaterialData texture arrays', () => {
  it('encodes unlit surfaces distinctly from lit and shadow-catching materials', () => {
    const unlit = new OpenPBRMaterial();
    unlit.unlit = true;
    unlit.emissionColor = [0.8, 0.2, 0.1];
    unlit.emissionLuminance = 1;
    const packed = new MergedMaterialData([unlit], []);
    expect(packed.bufferData.type).toEqual([UnlitMaterial]);
    expect(packed.getBufferArray()[3]).toBe(UnlitMaterial);
  });

  function stubCanvas() {
    const drawImage = vi.fn();
    vi.stubGlobal('WebGL2RenderingContext', {
      TEXTURE_2D: 0x0de1,
      TEXTURE_2D_ARRAY: 0x8c1a
    });
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage,
          restore: vi.fn(),
          save: vi.fn(),
          scale: vi.fn(),
          translate: vi.fn()
        })
      })
    });
    return drawImage;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('downscales oversized atlases to the configured byte budget', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const drawImage = stubCanvas();

    const materials = Array.from({ length: 2 }, () => {
      const material = new OpenPBRMaterial();
      material.map = new Texture({ width: 4096, height: 4096 } as HTMLImageElement);
      return material;
    });
    const maxTextureArrayBytes = 2 * 128 * 128 * 4;
    const materialData = new MergedMaterialData(materials, [], {
      maxTextureArrayBytes,
      maxTextureArrayLayers: 256,
      maxTextureDimension2D: 4096
    });

    const texture = materialData.texture!;
    expect(
      texture.width * texture.height * texture.source.length * 4
    ).toBeLessThanOrEqual(maxTextureArrayBytes);
    expect(texture.source).toHaveLength(1);
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it('packs smaller textures together instead of allocating one layer each', () => {
    const drawImage = stubCanvas();
    const sizes = [256, 64, 64, 64, 64];
    const materials = sizes.map((size) => {
      const material = new OpenPBRMaterial();
      material.map = new Texture({ width: size, height: size } as HTMLImageElement);
      return material;
    });

    const materialData = new MergedMaterialData(materials, [], {
      maxTextureArrayLayers: 256,
      maxTextureDimension2D: 4096
    });

    expect(materialData.texture?.source).toHaveLength(2);
    expect(materialData.bufferData.mapInfo).toHaveLength(5 * 4);
    expect(materialData.bufferData.mapTransform).toHaveLength(5 * 4);
    expect(materialData.textureAtlasStats).toMatchObject({
      estimatedBytes: 256 * 256 * 2 * 4,
      height: 256,
      layers: 2,
      scale: 1,
      textureCount: 5,
      width: 256
    });
    expect(drawImage).toHaveBeenCalledTimes(5);
  });

  it('packs per-texture UV tiling and offset alongside atlas metadata', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.map = new Texture({ width: 16, height: 16 } as HTMLImageElement);
    material.map.uvScale = [3, 2];
    material.map.uvOffset = [0.25, -0.5];
    material.map.uvChannel = 1;

    const materialData = new MergedMaterialData([material], []);

    expect(materialData.bufferData.mapTransform).toEqual([
      3, 2, 0.25, -0.5
    ]);
    expect(materialData.bufferData.mapUvChannel).toEqual([1]);
  });

  it('packs RGBA8 data textures without a DOM canvas', () => {
    const material = new OpenPBRMaterial();
    material.map = new Texture({
      width: 2,
      height: 2,
      data: new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255
      ])
    });
    material.map.flipY = true;

    const materialData = new MergedMaterialData([material], []);
    const page = materialData.texture!.source[0];

    expect(page).toMatchObject({ width: 2, height: 2 });
    expect(Array.from(page.data)).toEqual([
      0, 0, 255, 255,
      255, 255, 255, 255,
      255, 0, 0, 255,
      0, 255, 0, 255
    ]);
    expect(materialData.textureAtlasStats).toMatchObject({
      estimatedBytes: 16,
      layers: 1,
      textureCount: 1
    });
  });

  it('rejects texture counts above the renderer layer limit', () => {
    stubCanvas();
    const materials = Array.from({ length: 3 }, () => {
      const material = new OpenPBRMaterial();
      material.map = new Texture({ width: 4, height: 4 } as HTMLImageElement);
      return material;
    });

    expect(
      () =>
        new MergedMaterialData(materials, [], {
          maxTextureArrayBytes: 8,
          maxTextureArrayLayers: 2,
          maxTextureDimension2D: 1
        })
    ).toThrow('Unable to fit 3 textures into 2 atlas layers');
  });

  it('packs a thin-film thickness map and exposes its shader define', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.thinFilmMap = new Texture({
      width: 4,
      height: 4
    } as HTMLImageElement);

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(materialData.defines.NUM_THIN_FILM_MAPS).toBe(1);
    expect(materialData.bufferData.thinFilmMapIndex).toEqual([0]);
    expect(packed[9 * 4 + 1]).toBe(0);
    expect(packed[9 * 4 + 2]).toBeCloseTo(1.4);
  });

  it('packs standalone roughness and metalness maps independently', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.roughnessMap = new Texture({
      width: 4,
      height: 4
    } as HTMLImageElement);
    material.metalnessMap = new Texture({
      width: 8,
      height: 8
    } as HTMLImageElement);

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(materialData.defines.NUM_ROUGHNESS_MAPS).toBe(1);
    expect(materialData.defines.NUM_METALNESS_MAPS).toBe(1);
    expect(materialData.bufferData.roughnessMapIndex).toEqual([0]);
    expect(materialData.bufferData.metalnessMapIndex).toEqual([1]);
    expect(packed[22 * 4]).toBe(0);
    expect(packed[22 * 4 + 1]).toBe(1);
  });

  it('packs a standalone alpha map and cutoff', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.alphaMap = new Texture({
      width: 4,
      height: 4
    } as HTMLImageElement);
    material.alphaCutoff = 0.4;

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(materialData.defines.NUM_ALPHA_MAPS).toBe(1);
    expect(materialData.bufferData.alphaMapIndex).toEqual([0]);
    expect(materialData.bufferData.alphaMode).toEqual([1]);
    expect(packed[22 * 4 + 2]).toBe(0);
    expect(packed[22 * 4 + 3]).toBeCloseTo(0.4);
    expect(packed[23 * 4 + 3]).toBe(1);
  });

  it('packs a physical transmission map into the material buffer', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.transmissionWeight = 1;
    material.transmissionMap = new Texture({
      width: 8,
      height: 4
    } as HTMLImageElement);

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(materialData.defines.NUM_TRANSMISSION_MAPS).toBe(1);
    expect(materialData.bufferData.transmissionMapIndex).toEqual([0]);
    expect(packed[9 * 4 + 3]).toBe(0);
  });

  it('reuses the projective displacement height map for bump shading', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.displacementMap = new Texture({
      width: 32,
      height: 16
    } as HTMLImageElement);
    material.displacementBumpStrength = 40;

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(materialData.defines.NUM_BUMP_MAPS).toBe(1);
    expect(materialData.bufferData.displacementMapIndex).toEqual([0]);
    expect(materialData.bufferData.bumpMapIndex).toEqual([0]);
    expect(packed[23 * 4]).toBe(0);
    expect(packed[23 * 4 + 1]).toBe(40);
  });

  it('packs the double-sided flag into the material buffer', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.doubleSided = true;

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(materialData.bufferData.doubleSided).toEqual([1]);
    expect(packed[23 * 4 + 2]).toBe(1);
  });

  it('derives OpenPBR volume coefficients from color, depth and albedo', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.transmissionWeight = 1;
    material.transmissionColor = [Math.exp(-2), Math.exp(-1), 1];
    material.transmissionDepth = 0.5;
    material.transmissionScatter = [0.25, 0.5, 0];
    material.transmissionScatterAnisotropy = 0.4;

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();

    expect(Array.from(packed.slice(20 * 4, 20 * 4 + 3))).toEqual([
      4, 2, 0
    ]);
    expect(packed[20 * 4 + 3]).toBeCloseTo(0.4);
    expect(Array.from(packed.slice(21 * 4, 21 * 4 + 3))).toEqual([
      1, 1, 0
    ]);
  });

  it('derives a homogeneous OpenPBR subsurface volume from radius and color', () => {
    stubCanvas();
    const material = new OpenPBRMaterial();
    material.subsurfaceWeight = 1;
    material.subsurfaceColor = [0.8, 0.5, 0.25];
    material.subsurfaceRadius = 0.5;
    material.subsurfaceRadiusScale = [1, 0.5, 0.25];
    material.subsurfaceAnisotropy = 0.3;

    const materialData = new MergedMaterialData([material], []);
    const packed = materialData.getBufferArray();
    const extinction = Array.from(packed.slice(20 * 4, 20 * 4 + 3));
    const scattering = Array.from(packed.slice(21 * 4, 21 * 4 + 3));

    expect(extinction).toEqual([2, 4, 8]);
    expect(packed[20 * 4 + 3]).toBeCloseTo(0.3);
    expect(scattering.every((value) => value > 0)).toBe(true);
    expect(scattering.every((value, index) => value <= extinction[index])).toBe(
      true
    );
  });
});

it('repacking parameters matches fresh packing while preserving the texture atlas and indices', () => {
  const a = new OpenPBRMaterial(); const b = new OpenPBRMaterial();
  a.map = new Texture({ data: new Uint8Array([255,128,0,255]), width: 1, height: 1 });
  b.normalMap = a.map;
  const packed = new MergedMaterialData([a,b], []);
  const atlas = packed.texture; const info = packed.bufferData.mapInfo;
  const indices = packed.bufferData.diffuseMapIndex;
  a.baseColor = [0.2,0.4,0.5]; a.coatWeight = 1; a.opacity = 0.6; a.emissionLuminance = 5;
  b.transmissionWeight = 1; b.transmissionDepth = 2; b.subsurfaceWeight = 0.2;
  packed.repackParams([a,b]);
  expect(packed.texture).toBe(atlas); expect(packed.bufferData.mapInfo).toBe(info);
  expect(packed.bufferData.diffuseMapIndex).toBe(indices);
  expect(packed.getBufferArray()).toEqual(new MergedMaterialData([a,b], []).getBufferArray());
});

it('constructs material properties and packs public alpha strings without exposing numeric constants', () => {
  const materials = (['opaque', 'alpha', 'transmission'] as const).map(mapAlphaUsage =>
    new OpenPBRMaterial({ mapAlphaUsage, baseColor: [0.1, 0.2, 0.3], uvProjectionScale: [2, 3], displacementUvProjectionScale: 4 }));
  expect(materials[0]).toMatchObject({ version: 0, specularRoughness: .3, baseColor: [.1, .2, .3] });
  const packed = new MergedMaterialData(materials, []);
  expect(packed.bufferData.mapAlphaUsage).toEqual([0, 2, 3]);
  expect(packed.bufferData.uvScale).toEqual([[2, 3], [2, 3], [2, 3]]);
  expect(packed.bufferData.displacementUvProjectionScale).toEqual([4, 4, 4]);
});
