import * as THREE from 'three';
import { expect, it } from 'vitest';
import Engine from '../../src/Engine';
import Texture from '../../src/scene/Texture';
import Mesh from '../../src/scene/Mesh';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import Material from '../../src/scene/OpenPBRMaterial';
import MaterialTable from '../../src/renderer/MaterialTable';
import { constants } from '../../src/renderer/webgl';
import { MaterialChangeTracker } from '../../src/renderer/materialChanges';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';
import { THREESync } from '../../src/util/fromTHREE';

it('separates color encoding from storage precision without rewriting pixels', () => {
  const bytes=new Uint8Array([128,64,32,255]), floats=new Float32Array([2,.5,.25,1]);
  const linear=new Texture({width:1,height:1,data:bytes}); linear.colorSpace='linear';
  const srgb=new Texture({width:1,height:1,data:floats}); srgb.colorSpace='srgb';
  const table=new MaterialTable([new Material({map:linear}),new Material({map:srgb,roughnessMap:srgb})],[]);
  expect(table.bufferData.mapColorLinear).toEqual([1,0]);
  expect(table.texture!.storageType).toBe(constants.HALF_FLOAT);
  expect(floats).toEqual(new Float32Array([2,.5,.25,1]));
  const byteTable=new MaterialTable([new Material({map:linear})],[]);
  expect(byteTable.texture!.storageType).toBe(constants.UNSIGNED_BYTE);
  expect(byteTable.textureAtlasStats.estimatedBytes).toBe(4);
  expect(Array.from(byteTable.texture!.source[0].data)).toEqual(Array.from(bytes));
});

it('keeps automatic native defaults and detects encoding edits without a version bump', () => {
  const texture=new Texture({width:1,height:1,data:new Uint8Array([128,64,32,255])});
  expect(texture.colorSpace).toBeUndefined();
  const material=new Material({map:texture}), tracker=new MaterialChangeTracker();
  const source={meshes:[new Mesh(createCubeGeometry(),material)],lights:[],background:texture}, detector=new SceneChangeDetector();
  tracker.capture([material]); detector.detect(source); detector.commit();
  texture.colorSpace='linear';
  expect(tracker.classify([material]).level).toBe('textures');
  const changes=detector.detect(source);
  expect(changes.background).toBe(true); expect(changes.materials).toEqual([material]);
  expect(new MaterialTable([material],[]).bufferData.mapColorLinear).toEqual([1]);
});

it.each([THREE.LinearSRGBColorSpace,THREE.SRGBColorSpace,THREE.NoColorSpace])('imports and synchronizes %s without replacing the texture', colorSpace => {
  const map=new THREE.DataTexture(new Uint8Array([128,64,32,255]),1,1); map.colorSpace=colorSpace;
  const scene=new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.PlaneGeometry(),new THREE.MeshStandardMaterial({map})));
  const sync=new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene});
  sync.update(); const material=sync.scene!.meshes[0].materials[0], texture=material.map!;
  expect(texture.colorSpace).toBe(colorSpace===THREE.SRGBColorSpace?'srgb':'linear');
  const detector=new SceneChangeDetector(); detector.detect(sync.scene!); detector.commit();
  map.colorSpace=colorSpace===THREE.SRGBColorSpace?THREE.LinearSRGBColorSpace:THREE.SRGBColorSpace;
  sync.update(); expect(material.map).toBe(texture);
  expect(detector.detect(sync.scene!).materials).toEqual([material]);
  expect(new MaterialTable([material],[]).bufferData.mapColorLinear).toEqual([Number(map.colorSpace!==THREE.SRGBColorSpace)]);
  sync.dispose();
});
