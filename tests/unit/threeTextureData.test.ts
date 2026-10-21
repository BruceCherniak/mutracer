import * as THREE from 'three';
import { expect, it } from 'vitest';
import Engine from '../../src/Engine';
import MaterialTable from '../../src/renderer/MaterialTable';
import { fromTHREEScene, THREESync } from '../../src/util/fromTHREE';
import type { TextureDataSource } from '../../src/scene/Texture';

function scene(texture: THREE.DataTexture) {
  const source = new THREE.Scene();
  source.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: texture })));
  return source;
}

it.each([
  [THREE.RedFormat, [128], [128, 0, 0, 255]],
  [THREE.RGFormat, [128, 64], [128, 64, 0, 255]],
  [THREE.RGBAFormat, [128, 64, 32, 16], [128, 64, 32, 16]]
])('expands byte format %s to uploadable RGBA', (format, input, expected) => {
  const texture = new THREE.DataTexture(new Uint8Array(input), 1, 1, format);
  const materials = fromTHREEScene(scene(texture)).meshes[0].materials;
  const image = materials[0].map!.image as TextureDataSource;
  expect([...image.data]).toEqual(expected);
  expect(() => new MaterialTable(materials, [])).not.toThrow();
  expect([...texture.image.data!]).toEqual(input);
});

it.each([THREE.RedFormat, THREE.RGFormat, THREE.RGBAFormat])('decodes half-float format %s before atlas packing', format => {
  const count = format === THREE.RedFormat ? 1 : format === THREE.RGFormat ? 2 : 4;
  const texture = new THREE.DataTexture(new Uint16Array([0x4000, 0x3800, 0x3400, 0x3a00].slice(0, count)), 1, 1, format, THREE.HalfFloatType);
  const materials = fromTHREEScene(scene(texture)).meshes[0].materials;
  expect((materials[0].map!.image as TextureDataSource).data).toEqual(new Float32Array(
    count === 1 ? [2, 0, 0, 1] : count === 2 ? [2, .5, 0, 1] : [2, .5, .25, .75]));
  expect(() => new MaterialTable(materials, [])).not.toThrow();
});

it('normalizes unsigned-short storage instead of treating it as half-float', () => {
  const texture = new THREE.DataTexture(new Uint16Array([65535, 32768]), 1, 1, THREE.RGFormat, THREE.UnsignedShortType);
  const image = fromTHREEScene(scene(texture)).meshes[0].materials[0].map!.image as TextureDataSource;
  expect(image.data).toEqual(new Float32Array([1, 32768 / 65535, 0, 1]));
});

it('retains decoded storage until pixel updates, then refreshes the same texture', () => {
  const texture = new THREE.DataTexture(new Uint16Array([0x3c00]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
  const source = scene(texture);
  const sync = new THREESync(new Engine({ canvas: {width: 1, height: 1} as HTMLCanvasElement }), {scene: source});
  sync.update();
  const converted = sync.scene!.meshes[0].materials[0].map!, image = converted.image;
  sync.update(); expect(converted.image).toBe(image);
  texture.image.data![0] = 0x4000; texture.needsUpdate = true; sync.update();
  expect(sync.scene!.meshes[0].materials[0].map).toBe(converted);
  expect((converted.image as TextureDataSource).data[0]).toBe(2);
  expect(converted.image).not.toBe(image); sync.dispose();
});
