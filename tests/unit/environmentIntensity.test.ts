import * as THREE from 'three';
import { expect, it } from 'vitest';
import Texture from '../../src/scene/Texture';
import type {TextureDataSource} from '../../src/scene/Texture';
import EnvironmentLight from '../../src/scene/EnvironmentLight';
import AmbientLight from '../../src/scene/AmbientLight';
import Engine from '../../src/Engine';
import { THREESync } from '../../src/util/fromTHREE';
import { generateEnvMapFromSceneComponents, initializeEnvMap } from '../../src/renderer/envMapCreation';
import type { EnvironmentSource } from '../../src/renderer/envMapDistribution';
import { estimateEnvironmentPower } from '../../src/renderer/lightSampling';

it('scales only environment RGB, preserving the source, alpha and ambient radiance', () => {
  const pixels = new Float32Array([2,.5,.25,.75]);
  const light = new EnvironmentLight({map:new Texture({width:1,height:1,data:pixels}),intensity:2});
  const image = pixelsOf(generateEnvMapFromSceneComponents([new AmbientLight({intensity:.25})],[light]));
  expect(image.data).toEqual(new Float32Array([4.25,1.25,.75,.75]));
  expect(pixels).toEqual(new Float32Array([2,.5,.25,.75]));
  light.intensity=0;
  expect(pixelsOf(generateEnvMapFromSceneComponents([new AmbientLight({intensity:.25})],[light])).data)
    .toEqual(new Float32Array([.25,.25,.25,.75]));
});

it('retains processed pixels until intensity, source or version changes', () => {
  const map = new Texture({width:1,height:1,data:new Float32Array([1,2,3,1])});
  const light = new EnvironmentLight({map,intensity:.5});
  const a=pixelsOf(initializeEnvMap([light])); expect(initializeEnvMap([light])).toBe(a);
  light.intensity=2; const b=pixelsOf(initializeEnvMap([light])); expect(b.data).toEqual(new Float32Array([2,4,6,1]));
  expect(estimateEnvironmentPower(b)).toBeCloseTo(estimateEnvironmentPower(a)*4);
  map.markUpdated(); expect(pixelsOf(initializeEnvMap([light])).data).not.toBe(b.data);
  light.intensity=1; expect(pixelsOf(initializeEnvMap([light])).data).toBe((map.image as TextureDataSource).data);
});

it('normalizes byte environments before intensity and ambient arithmetic', () => {
  const light=new EnvironmentLight({map:new Texture({width:1,height:1,data:new Uint8Array([255,128,0,255])}),intensity:2});
  expect(pixelsOf(initializeEnvMap([light])).data).toEqual(new Float32Array([2,256/255,0,1]));
});

it('imports and synchronizes scene.environmentIntensity independently from the displayed background', () => {
  const scene=new THREE.Scene(); scene.environment=new THREE.DataTexture(new Float32Array([2,.5,1,1]),1,1,THREE.RGBAFormat,THREE.FloatType);
  scene.background=scene.environment; scene.environmentIntensity=.5;
  const sync=new THREESync(new Engine({canvas:{width:1,height:1} as HTMLCanvasElement}),{scene}); sync.update();
  const light=sync.scene!.lights[0] as EnvironmentLight, background=sync.scene!.background;
  expect(light.intensity).toBe(.5); scene.environmentIntensity=0; sync.update();
  expect(sync.scene!.lights[0]).toBe(light); expect(light.intensity).toBe(0);
  expect(sync.scene!.background).toBe(background); sync.dispose();
});

function pixelsOf(source: EnvironmentSource) {
  if ('sky' in source) throw new Error('Expected CPU pixels');
  return source;
}
