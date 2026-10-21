import * as THREE from 'three';
import { expect, it } from 'vitest';
import Texture from '../../src/scene/Texture';
import EnvironmentLight from '../../src/scene/EnvironmentLight';
import AmbientLight from '../../src/scene/AmbientLight';
import Engine from '../../src/Engine';
import { THREESync } from '../../src/util/fromTHREE';
import { environmentRotation } from '../../src/renderer/envMapCreation';
import { SceneEnvironmentCache } from '../../src/renderer/sceneLightChanges';
import { SceneChangeDetector } from '../../src/renderer/sceneChangeDetector';

const map = () => new Texture({width:1,height:1,data:new Float32Array([1,2,3,1])});

it('uses identity by default and extracts orientation without translation or positive axis scale', () => {
  const light = new EnvironmentLight({map:map()});
  expect(environmentRotation([light])).toEqual(environmentRotation([]));
  light.transform = new THREE.Matrix4().makeRotationY(.7).elements;
  const rotation = environmentRotation([light]);
  light.transform = new THREE.Matrix4().fromArray(light.transform).scale(new THREE.Vector3(2,3,4)).elements; light.position=[7,8,9];
  expect(environmentRotation([light])).toEqual(rotation);
  expect(rotation[0]).toBeCloseTo(Math.cos(.7)); expect(rotation[8]).toBeCloseTo(Math.sin(.7));
});

it('synchronizes all Three.js Euler orders and keeps explicit background orientation independent', () => {
  const scene = new THREE.Scene();
  scene.environment=new THREE.DataTexture(new Float32Array([1,2,3,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
  scene.background=scene.environment;
  const sync=new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene});
  sync.update(); const light=sync.scene!.lights[0] as EnvironmentLight, background=sync.scene!.background;
  for (const order of ['XYZ','XZY','YXZ','YZX','ZXY','ZYX'] as const) {
    scene.environmentRotation.set(.2,.5,-.3,order); sync.update();
    expect(sync.scene!.lights[0]).toBe(light);
    expect(Array.from(environmentRotation([light]))).toEqual(Array.from(new Float32Array(new THREE.Matrix4().makeRotationFromEuler(scene.environmentRotation).elements)));
    expect(sync.scene!.background).toBe(background);
  }
  sync.dispose();
});

it('detects in-place rotation while retaining environment pixels and their distribution source', () => {
  const light=new EnvironmentLight({map:map(),intensity:2});
  const scene={meshes:[],lights:[light,new AmbientLight()]};
  const detector=new SceneChangeDetector(), cache=new SceneEnvironmentCache();
  detector.detect(scene); detector.commit(); const image=cache.update(scene.lights);
  const rotated=new THREE.Matrix4().makeRotationX(.5).elements;
  for(let i=0;i<16;i++) light.transform[i]=rotated[i];
  expect(detector.detect(scene).lights).toBe(true); expect(cache.update(scene.lights)).toBe(image);
  light.intensity=3; expect(cache.update(scene.lights)).not.toBe(image);
});
