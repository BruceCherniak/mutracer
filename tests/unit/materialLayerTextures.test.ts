import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import Material, { getMaterialHashKey, materialTextureKeys } from '../../src/scene/OpenPBRMaterial';
import { MATERIAL_TEXTURE_NAMES } from '../../src/scene/materialTextureNames';
import { MATERIAL_TEXTURE_SLOTS } from '../../src/renderer/materialTextureSlots';
import Texture from '../../src/scene/Texture';
import MaterialTable from '../../src/renderer/MaterialTable';
import { MaterialChangeTracker, materialIsEmissive } from '../../src/renderer/materialChanges';
import { collectEmissiveTriangles, EmissiveTriangleCache, colorLuminance, buildLightAliasTable } from '../../src/renderer/lightSampling';
import { materialEmission } from '../../src/renderer/materialEmission';
import Mesh from '../../src/scene/Mesh';
import { createPlaneGeometry } from '../../src/util/commonGeometry';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import Engine from '../../src/Engine';

const newNames = ['coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap', 'specularWeightMap', 'specularColorMap'] as const;
// Independent offsets, channels and feature bits from the approved C1 contract.
const offsets = [24, 25, 27, 75, 79, 87];
const sourceNames = ['clearcoatMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'specularIntensityMap', 'specularColorMap'] as const;
const texture = () => new Texture({width: 2, height: 2, data: new Uint8Array(16).fill(128)});
function convert(source: THREE.MeshPhysicalMaterial) {
  const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
  return fromTHREEScene(scene).meshes[0].materials[0];
}

describe('OpenPBR layer texture inputs', () => {
  it('has exactly one renderer descriptor for each scene texture name and schema field', () => {
    const schemaNames = materialTextureKeys.filter(name => name !== 'displacementBumpStrength');
    expect([...schemaNames].sort()).toEqual([...MATERIAL_TEXTURE_NAMES].sort());
    expect(MATERIAL_TEXTURE_SLOTS.map(slot => slot.property)).toEqual([...MATERIAL_TEXTURE_NAMES]);
    expect(new Set(MATERIAL_TEXTURE_SLOTS.map(slot => slot.property)).size).toBe(17);
    expect(MATERIAL_TEXTURE_SLOTS.slice(10).map(slot => [slot.channel, slot.colorSpace, slot.featureBit])).toEqual([
      ['r', 'linear', 2 ** 15], ['g', 'linear', 2 ** 16], ['rgb', 'srgb', 2 ** 18],
      ['a', 'linear', 2 ** 19], ['a', 'linear', 2 ** 20], ['rgb', 'srgb', 2 ** 21], ['rg/b', 'linear', 2 ** 22]
    ]);
  });
  it('appends atlas indices with sharing, UV metadata and missing sentinels', () => {
    const textures = MATERIAL_TEXTURE_NAMES.map(texture);
    textures[10].uvChannel = 1; textures[10].uvScale = [2, 3]; textures[10].uvOffset = [.1, .2];
    const material = new Material(Object.fromEntries(MATERIAL_TEXTURE_NAMES.map((name, i) => [name, textures[i]])));
    const table = new MaterialTable([material, new Material({coatWeightMap: textures[10], specularColorMap: textures[10]}), new Material()], []);
    expect(table.defines.NUM_MAPS).toBe(17);
    const packed = table.getBufferArray();
    offsets.forEach((offset, i) => {
      expect(packed[offset]).toBe(10 + i);
      expect(packed[208 + offset]).toBe(-1);
    });
    expect(packed[104 + 24]).toBe(10); expect(packed[104 + 87]).toBe(10);
    expect(table.bufferData.mapUvChannel[10]).toBe(1);
    expect(table.bufferData.mapTransform.slice(40, 44)).toEqual([2, 3, .1, .2]);
    expect(table.defines.NUM_COAT_WEIGHT_MAPS).toBe(2);
    expect(table.defines.NUM_SPECULAR_COLOR_MAPS).toBe(2);
  });
  it.each(newNames)('classifies %s enable/edit/remove without geometry changes', name => {
    const material = new Material(), tracker = new MaterialChangeTracker();
    tracker.capture([material]); const hash = getMaterialHashKey(material);
    material[name] = texture(); material.markUpdated();
    expect(getMaterialHashKey(material)).not.toBe(hash);
    expect(tracker.classify([material])).toEqual({level: 'textures', emission: name === 'coatWeightMap', emissiveMap: false});
    tracker.capture([material]); material[name]!.uvChannel = 1; material[name]!.markUpdated();
    expect(tracker.classify([material]).level).toBe('textures');
    tracker.capture([material]); material[name] = undefined; material.markUpdated();
    expect(tracker.classify([material]).level).toBe('textures');
  });
  it.each(newNames.map((name, i) => [name, sourceNames[i]] as const))('imports %s through Three.js and preserves shared identity', (name, sourceName) => {
    const source = new THREE.MeshPhysicalMaterial(); const image = new THREE.Texture({width: 2, height: 2});
    image.channel = 1; image.repeat.set(2, 3); image.offset.set(.2, .3); image.flipY = false;
    source[sourceName] = image; source.map = image;
    const m = convert(source);
    expect(m[name]).toBe(m.map);
    expect(m[name]).toMatchObject({uvChannel: 1, uvScale: [2, 3], uvOffset: [.2, .3], flipY: false});
    const override = texture(); source.userData.mutracerOpenPBR = {[name]: override}; expect(convert(source)[name]).toBe(override);
    const other = new THREE.Texture({width: 1, height: 1}); source.userData.mutracerOpenPBR = {[name]: other};
    expect(convert(source)[name]?.image).toBe(other.image);
    source.userData.mutracerOpenPBR = {[name]: {width: 1, height: 1}};
    expect(convert(source)[name]?.image).toBe(image.image);
    source.userData.mutracerOpenPBR = {[name]: null}; expect(convert(source)[name]).toBeUndefined();
  });
  it('THREESync retains material identity while updating imported layer maps', () => {
    const source = new THREE.MeshPhysicalMaterial(); const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(), source));
    const sync = new THREESync(new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}), {scene}); sync.update();
    const m = sync.scene!.meshes[0].materials[0], before = m.version;
    for (const name of sourceNames) source[name] = new THREE.Texture({width: 1, height: 1});
    sync.update(); expect(sync.scene!.meshes[0].materials[0]).toBe(m); expect(m.version).toBeGreaterThan(before);
    for (const name of newNames) expect(m[name]).toBeInstanceOf(Texture);
    source.clearcoatMap = null; sync.update(); expect(m.coatWeightMap).toBeUndefined();
  });
  it('keeps raw proposal luminance in packing, full/cache distributions and alias PMFs', () => {
    const mapped = new Material({coatWeight: 1, coatColor: [0, 0, 0], coatWeightMap: texture(), emissionColor: [1, .5, .25], emissionLuminance: 4});
    const constant = new Material({coatWeight: .5, coatColor: [.25, 1, 0], emissionLuminance: 2});
    const materials = [mapped, constant];
    const bindings = materials.map((m, i) => { const mesh = new Mesh(createPlaneGeometry(), m); return {mesh, geometry: mesh.geometry, materialIndices: [i]}; });
    const cache = new EmissiveTriangleCache();
    expect(materialEmission(mapped)).toEqual([4, 2, 1]); expect(materialIsEmissive(mapped)).toBe(true);
    const packed = new MaterialTable(materials, []).getBufferArray();
    expect(Array.from(packed.slice(12, 15))).toEqual([4, 2, 1]);
    for (const operation of ['initial', 'color', 'edit', 'remove', 'restore'] as const) {
      if (operation === 'color') mapped.coatColor = [.2, .4, .6];
      if (operation === 'edit') mapped.coatWeightMap!.markUpdated();
      if (operation === 'remove') mapped.coatWeightMap = undefined;
      if (operation === 'restore') mapped.coatWeightMap = texture();
      const full = collectEmissiveTriangles(bindings, materials), incremental = cache.collect(bindings, materials);
      expect(incremental.map(t => t.samplingLuminance)).toEqual(full.map(t => t.samplingLuminance));
      for (const t of full) expect(t.samplingLuminance).toBe(colorLuminance(materialEmission(materials[t.materialIndex])));
      const dist = buildLightAliasTable(full.map((t, i) => ({sourceType: 3, sourceIndex: i, weight: t.area * t.samplingLuminance})));
      const sum = full.reduce((s, t) => s + t.area * t.samplingLuminance, 0);
      full.forEach((t, i) => expect(dist.pmfs[i]).toBeCloseTo(t.area * t.samplingLuminance / sum));
      const repacked = new MaterialTable(materials, []).getBufferArray();
      expect(Array.from(repacked.slice(12, 15))).toEqual(materialEmission(mapped).map(Math.fround));
    }
    mapped.coatWeightMap = undefined; mapped.coatColor = [0, 0, 0];
    expect(materialIsEmissive(mapped)).toBe(false);
    expect(cache.collect(bindings, materials)).toHaveLength(2);
  });
});
