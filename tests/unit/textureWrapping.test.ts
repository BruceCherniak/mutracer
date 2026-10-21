import * as THREE from 'three';
import { expect, it } from 'vitest';
import Engine from '../../src/Engine';
import Texture from '../../src/scene/Texture';
import Material from '../../src/scene/OpenPBRMaterial';
import MaterialTable from '../../src/renderer/MaterialTable';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import { THREESync } from '../../src/util/fromTHREE';

it('packs independent wrap axes and preserves the native repeat default', () => {
  const a = new Texture({width: 1, height: 1, data: new Float32Array([1,1,1,1])});
  const b = new Texture(a.image); b.wrapS = 'clamp-to-edge'; b.wrapT = 'mirrored-repeat';
  const table = new MaterialTable([new Material({map:a}), new Material({map:b})], []);
  expect(table.bufferData.mapWrap).toEqual([0,0,1,2]);
});

it('classifies wrap edits as texture updates, including displacement bounds', () => {
  const texture = new Texture({width: 1, height: 1, data: new Float32Array([1,1,1,1])});
  const material = new Material({map: texture}), tracker = new MaterialChangeTracker();
  tracker.capture([material]); texture.wrapS = 'clamp-to-edge';
  expect(tracker.classify([material]).level).toBe('textures');
  material.displacementMap = texture; tracker.capture([material]); texture.wrapT = 'mirrored-repeat';
  expect(tracker.classify([material]).level).toBe('geometry');
});

it.each([THREE.RepeatWrapping, THREE.ClampToEdgeWrapping, THREE.MirroredRepeatWrapping])('imports and synchronizes wrap mode %s without replacing the texture', wrap => {
  const map = new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1);
  map.wrapS = map.wrapT = wrap;
  const source = new THREE.Scene(); source.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({map})));
  const sync = new THREESync(new Engine({canvas: {width:1,height:1} as HTMLCanvasElement}), {scene:source});
  sync.update(); const converted = sync.scene!.meshes[0].materials[0].map!;
  const expected = wrap === THREE.RepeatWrapping ? 'repeat' : wrap === THREE.ClampToEdgeWrapping ? 'clamp-to-edge' : 'mirrored-repeat';
  expect([converted.wrapS, converted.wrapT]).toEqual([expected, expected]);
  const detector = new SceneChangeDetector(); detector.detect(sync.scene!); detector.commit();
  map.wrapS = wrap === THREE.RepeatWrapping ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  sync.update();
  expect(sync.scene!.meshes[0].materials[0].map).toBe(converted);
  expect(converted.wrapS).not.toBe(expected); expect(converted.wrapT).toBe(expected);
  expect(detector.detect(sync.scene!).materials).toEqual([sync.scene!.meshes[0].materials[0]]);
  sync.dispose();
});

it('detects native wrap changes without a texture version bump', () => {
  const texture = new Texture({width:1,height:1,data:new Uint8Array([255,255,255,255])});
  const material = new Material({map:texture});
  const source = {meshes:[],lights:[],background:texture};
  const detector = new SceneChangeDetector(); detector.detect(source); detector.commit();
  texture.wrapS = 'clamp-to-edge';
  expect(detector.detect(source).background).toBe(true);
  expect(new MaterialTable([material],[]).bufferData.mapWrap).toEqual([1,0]);
});
