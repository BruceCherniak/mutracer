import { describe, expect, it } from 'vitest';
import Material from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import MaterialTable from '../../src/renderer/MaterialTable';
import { materialTextureFeatures } from '../../src/renderer/materialTextureSlots';
import { WGPU_SCENE_FEATURE_BITS, wgpuSceneFeatureFlags } from '../../src/renderer/WGPUSceneFeatures';

// These are the existing public slots and GPU byte positions, independent of
// the new descriptors. Shared/absent maps exercise atlas indexing and counts.
const names = ['map', 'alphaMap', 'normalMap', 'emissiveMap', 'metallicRoughnessMap',
  'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'displacementMap'] as const;
const offsets = [10, 90, 5, 15, 11, 88, 89, 39, 37, 29];

describe('internal material texture slots', () => {
  it('preserves atlas order, shared indices, missing indices and per-slot counts', () => {
    const textures = names.map(() => new Texture({width: 1, height: 1, data: new Uint8Array([51,153,230,204])}));
    const params = Object.fromEntries(names.map((name, i) => [name, textures[i]]));
    const table = new MaterialTable([new Material(params), new Material(params), new Material()], []);
    const packed = table.getBufferArray();
    expect(table.defines.NUM_MAPS).toBe(10);
    for (const [index, offset] of offsets.entries()) {
      expect(packed[offset]).toBe(index);
      expect(packed[96 + offset]).toBe(index);
      expect(packed[192 + offset]).toBe(-1);
    }
    for (const define of ['NUM_DIFFUSE_MAPS', 'NUM_ALPHA_MAPS', 'NUM_NORMAL_MAPS', 'NUM_EMISSIVE_MAPS',
      'NUM_METALLIC_ROUGHNESS_MAPS', 'NUM_ROUGHNESS_MAPS', 'NUM_METALNESS_MAPS', 'NUM_TRANSMISSION_MAPS', 'NUM_THIN_FILM_MAPS']) {
      expect(table.defines[define], define).toBe(2);
    }
    expect(table.defines.NUM_BUMP_MAPS).toBe(0);
    expect(wgpuSceneFeatureFlags(materialTextureFeatures(table.defines))).toBe(1022);
  });

  it('keeps texture feature bits and dynamic enable/disable contracts', () => {
    expect(WGPU_SCENE_FEATURE_BITS).toEqual({
      USE_ENVMAP: 1, USE_DIFFUSE_MAPS: 2, USE_ALPHA_MAPS: 4, USE_METALLIC_ROUGHNESS_MAPS: 8,
      USE_ROUGHNESS_MAPS: 16, USE_METALNESS_MAPS: 32, USE_TRANSMISSION_MAPS: 64,
      USE_EMISSIVE_MAPS: 128, USE_THIN_FILM_MAPS: 256, USE_NORMAL_MAPS: 512,
      HAS_THIN_FILM: 1024, HAS_COAT: 2048, HAS_FUZZ: 4096, HAS_SUBSURFACE: 8192, HAS_SHADOW_CATCHER: 16384
    });
    const material = new Material({roughnessMap: new Texture({width:1,height:1,data:new Uint8Array(4)})});
    expect(wgpuSceneFeatureFlags(materialTextureFeatures(new MaterialTable([material], []).defines))).toBe(16);
    material.roughnessMap = undefined;
    expect(wgpuSceneFeatureFlags(materialTextureFeatures(new MaterialTable([material], []).defines))).toBe(0);
  });
});
