import {describe, expect, it} from 'vitest';
import * as THREE from 'three';
import Material, {getMaterialHashKey} from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import {MATERIAL_TEXTURE_NAMES} from '../../src/scene/materialTextureNames';
import MaterialTable from '../../src/renderer/MaterialTable';
import {packMaterialBuffer} from '../../src/renderer/materialLayout';
import {MaterialChangeTracker} from '../../src/renderer/materialChanges';
import {materialTextureFeatures} from '../../src/renderer/materialTextureSlots';
import {wgpuSceneFeatureFlags} from '../../src/renderer/WGPUSceneFeatures';
import {fromTHREEScene, THREESync} from '../../src/util/fromTHREE';
import Engine from '../../src/Engine';

const image = () => new Texture({width: 2, height: 2, data: new Uint8Array(16).fill(128)});
function sceneFor(source: THREE.MeshPhysicalMaterial) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), source));
  return scene;
}
function convert(source: THREE.MeshPhysicalMaterial) {
  return fromTHREEScene(sceneFor(source)).meshes[0].materials[0];
}

describe('independent coat normal inputs', () => {
  it('appends the slot to the public sequence and owns independent scale storage', () => {
    expect(MATERIAL_TEXTURE_NAMES).toEqual([
      'map', 'alphaMap', 'normalMap', 'emissiveMap', 'metallicRoughnessMap',
      'roughnessMap', 'metalnessMap', 'transmissionMap', 'thinFilmMap', 'displacementMap',
      'coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap',
      'specularWeightMap', 'specularColorMap', 'anisotropyMap', 'coatNormalMap'
    ]);
    const m = new Material(), other = new Material();
    expect(m.coatNormalMap).toBeUndefined();
    expect(m.coatNormalScale).toEqual([1, 1]);
    m.coatNormalScale[0] = -2;
    expect(m.normalScale).toEqual([1, 1]);
    expect(other.coatNormalScale).toEqual([1, 1]);
    const tex = image();
    expect(new Material({coatNormalMap: tex}).coatNormalMap).toBe(tex);
  });

  it.each([false, true])('uses the preallocated bytes without disturbing directions, source model or film (TFDM=%s)', tfdm => {
    const tex = image(); tex.uvChannel = 1; tex.uvScale = [-2, 3]; tex.uvOffset = [.1, .2]; tex.flipY = false;
    const m = new Material({map: tex, coatNormalMap: tex, coatNormalScale: [-.5, 2],
      anisotropyMap: image(), specularAnisotropyRotation: .7, coatAnisotropyRotation: -.3,
      specularAnisotropyModel: 'gltf', thinFilmThicknessMinimum: .2, thinFilmMapChannel: 'g'});
    const absent = new Material(); const table = new MaterialTable([m, absent], []);
    const bytes = packMaterialBuffer(table.bufferData, tfdm);
    expect(bytes.length).toBe(208);
    expect(bytes[26]).toBe(0); expect(bytes[130]).toBe(-1);
    expect(Array.from(bytes.slice(96, 104))).toEqual([1, Math.fround(.7), -.5, 2,
      Math.fround(-.3), 1, Math.fround(.2), 1]);
    expect(table.defines.NUM_MAPS).toBe(2);
    expect(table.defines.NUM_COAT_NORMAL_MAPS).toBe(1);
    expect(table.bufferData.mapUvChannel).toEqual([1, 0]);
    expect(table.bufferData.mapTransform.slice(0, 4)).toEqual([-2, 3, .1, .2]);
    const features = materialTextureFeatures(table.defines);
    expect(features.USE_COAT_NORMAL_MAPS).toBe(true);
    expect(wgpuSceneFeatureFlags(features) & (2 ** 17)).toBe(2 ** 17);
    m.coatNormalScale = [0, -3]; table.repackParams([m, absent]);
    const repacked = packMaterialBuffer(table.bufferData, tfdm);
    expect(repacked[26]).toBe(0); expect(repacked[96]).toBe(1);
    expect(Array.from(repacked.slice(98, 100))).toEqual([0, -3]);
  });

  it('invalidates parameters or textures without rebuilding geometry or emission proposals', () => {
    const m = new Material({emissionLuminance: 1}), tracker = new MaterialChangeTracker();
    tracker.capture([m]); const hash = getMaterialHashKey(m);
    m.coatNormalScale = [.3, -1];
    expect(getMaterialHashKey(m)).not.toBe(hash);
    expect(tracker.classify([m])).toEqual({level: 'params', emission: false, emissiveMap: false});
    for (const change of [() => { m.coatNormalMap = image(); },
      () => { m.coatNormalMap!.uvChannel = 1; m.coatNormalMap!.markUpdated(); },
      () => { m.coatNormalMap!.flipY = false; m.coatNormalMap!.markUpdated(); },
      () => { m.coatNormalMap = undefined; }]) {
      tracker.capture([m]); change();
      expect(tracker.classify([m])).toEqual({level: 'textures', emission: false, emissiveMap: false});
    }
    const table = new MaterialTable([m], []);
    expect(table.getBufferArray()[26]).toBe(-1);
    expect(materialTextureFeatures(table.defines).USE_COAT_NORMAL_MAPS).toBe(false);
  });

  it('converts clearcoat normal maps through the shared texture cache with independent scale', () => {
    const tex = new THREE.Texture({width: 2, height: 2});
    tex.channel = 1; tex.repeat.set(2, -3); tex.offset.set(.2, .3); tex.flipY = false;
    const source = new THREE.MeshPhysicalMaterial({normalMap: tex, clearcoatNormalMap: tex});
    source.normalScale.set(.2, .4); source.clearcoatNormalScale.set(-.7, 1.5);
    const m = convert(source);
    expect(m.coatNormalMap).toBe(m.normalMap);
    expect(m.coatNormalMap).toMatchObject({uvChannel: 1, uvScale: [2, -3], uvOffset: [.2, .3], flipY: false});
    expect(m.coatNormalScale).toEqual([-.7, 1.5]);
    expect(m.normalScale).toEqual([.2, .4]);
    m.coatNormalScale[0] = 9;
    expect(source.clearcoatNormalScale.x).toBe(-.7);
    expect(m.coatIor).toBe(1.5); expect(m.coatDarkening).toBe(0);
  });

  it('applies supported metadata after the Three import and ignores JSON texture lookalikes', () => {
    const imported = new THREE.Texture({width: 2, height: 2});
    const source = new THREE.MeshPhysicalMaterial({clearcoatNormalMap: imported});
    source.clearcoatNormalScale.set(.4, .8);
    const native = image(); source.userData.mutracerOpenPBR = {coatNormalMap: native, coatNormalScale: [-1, 0]};
    expect(convert(source).coatNormalMap).toBe(native);
    expect(convert(source).coatNormalScale).toEqual([-1, 0]);
    const other = new THREE.Texture({width: 1, height: 1});
    source.userData.mutracerOpenPBR = {coatNormalMap: other};
    expect(convert(source).coatNormalMap?.image).toBe(other.image);
    source.userData.mutracerOpenPBR = {coatNormalMap: {isTexture: true, image: imported.image}};
    expect(convert(source).coatNormalMap?.image).toBe(imported.image);
    source.userData.mutracerOpenPBR = {coatNormalMap: null, coatNormalScale: [NaN, -2]};
    expect(convert(source).coatNormalMap).toBeUndefined();
    expect(convert(source).coatNormalScale).toEqual([.4, -2]);
    // Unrelated native metadata must retain C6's source model and directions.
    source.anisotropy = .6; source.anisotropyRotation = .7;
    source.userData.mutracerOpenPBR = {coatNormalScale: [.3, 1]};
    expect(convert(source)).toMatchObject({specularAnisotropyModel: 'gltf', specularAnisotropy: .6, specularAnisotropyRotation: .7});
  });

  it('selects the existing automatic UV projection for a coat-only texture on missing-UV geometry', () => {
    const source = new THREE.MeshPhysicalMaterial({clearcoatNormalMap: new THREE.Texture({width: 2, height: 2})});
    source.clearcoatNormalScale.set(.3, -.5);
    const geometry = new THREE.PlaneGeometry(); geometry.deleteAttribute('uv');
    const scene = new THREE.Scene(); scene.add(new THREE.Mesh(geometry, source));
    const m = fromTHREEScene(scene).meshes[0].materials[0];
    expect(m.uvProjection).toBe('triplanar');
    expect(m.coatNormalMap?.image).toBe(source.clearcoatNormalMap!.image);
    expect(m.coatNormalScale).toEqual([.3, -.5]);
  });

  it('THREESync preserves identity across imported texture and scale edits, including removal', () => {
    const source = new THREE.MeshPhysicalMaterial();
    const sync = new THREESync(new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}), {scene: sceneFor(source)});
    sync.update(); const m = sync.scene!.meshes[0].materials[0], hash = getMaterialHashKey(m);
    const tex = new THREE.Texture({width: 2, height: 2});
    source.clearcoatNormalMap = tex; source.clearcoatNormalScale.set(.5, -1); sync.update();
    expect(sync.scene!.meshes[0].materials[0]).toBe(m); expect(getMaterialHashKey(m)).not.toBe(hash);
    expect(m.coatNormalMap?.image).toBe(tex.image); expect(m.coatNormalScale).toEqual([.5, -1]);
    source.clearcoatNormalMap = null; sync.update(); expect(m.coatNormalMap).toBeUndefined();
  });
});
