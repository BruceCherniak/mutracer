import { expect, it, vi } from 'vitest';
import OpenPBRMaterial, { materialKeys, materialTextureKeys, materialGeometryKeys, materialParamKeys } from '../../src/scene/OpenPBRMaterial';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import Mesh from '../../src/scene/Mesh';
import { createCubeGeometry } from '../../src/util/commonGeometry';

it('exhaustively classifies independent material property groups', () => {
  const material = new OpenPBRMaterial();
  const grouped = [...materialTextureKeys, ...materialGeometryKeys, ...materialParamKeys];
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...grouped].sort()).toEqual([...materialKeys].sort());
  expect(Object.keys(material).sort()).toEqual([...materialKeys].sort());
});

it('detects scalar, vector element, vector replacement and displacement bump edits without notifications', () => {
  const material = new OpenPBRMaterial(), geometry = createCubeGeometry();
  const scene = {meshes: [new Mesh(geometry, material)], lights: []};
  const detector = new SceneChangeDetector(); detector.detect(scene); detector.commit();
  for (const edit of [() => {material.specularRoughness = .7;}, () => {material.baseColor[1] = .2;},
    () => {material.baseColor = [.1,.2,.3];}, () => {material.displacementBumpStrength = .5;}]) {
    edit();
    expect(detector.detect(scene)).toMatchObject({meshes: 'incremental', materials: [material], transforms: [], geometries: []});
    detector.commit(); expect(detector.detect(scene).meshes).toBe('none');
  }
  material.baseColor = [...material.baseColor];
  expect(detector.detect(scene).materials).toEqual([]);
});

it('compares a shared material once and reports its change once', () => {
  const material = new OpenPBRMaterial(), geometry = createCubeGeometry();
  const scene = {meshes: Array.from({length: 50}, () => new Mesh(geometry, material)), lights: []};
  const detector = new SceneChangeDetector(); detector.detect(scene); detector.commit();
  material.baseColor[0] = .2;
  const read = vi.fn(() => .8);
  Object.defineProperty(material, 'baseWeight', {get: read, configurable: true});
  expect(detector.detect(scene).materials).toEqual([material]);
  // One comparison and one capture of pending state, independent of mesh count.
  expect(read).toHaveBeenCalledTimes(2);
});
