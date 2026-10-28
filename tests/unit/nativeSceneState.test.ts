import { expect, it } from 'vitest';
import InstanceState from '../../src/scene/InstanceState.js';
import InstancedMesh from '../../src/scene/InstancedMesh.js';
import Mesh from '../../src/scene/Mesh.js';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial.js';
import { createPlaneGeometry } from '../../src/util/commonGeometry.js';

it('keeps native and browser instance storage, revisions and notifications equivalent', () => {
  const geometry = createPlaneGeometry(), material = new OpenPBRMaterial();
  const native = new InstanceState({count: 2}), browser = new InstancedMesh(geometry, material, {count: 2});
  expect(browser).toBeInstanceOf(Mesh);
  expect(native.transforms).toEqual(browser.transforms);
  for (const state of [native, browser]) {
    const transforms = state.transforms;
    state.transforms[12] = 3;
    expect(state.markTransformsUpdated(0, 1)).toBe(state);
    state.colors = new Float32Array(6).fill(.5);
    expect(state.markColorsUpdated()).toBe(state);
    expect(state.markUpdated()).toBe(state);
    expect(state.transforms).toBe(transforms);
  }
  expect(native.transforms).toEqual(browser.transforms);
  expect(native.colors).toEqual(browser.colors);
  expect([native.version, native.transformsVersion, native.colorsVersion])
    .toEqual([browser.version, browser.transformsVersion, browser.colorsVersion]);
  const view = browser.instanceData;
  browser.count = 1;
  browser.markTransformsUpdated();
  expect(view.count).toBe(1);
  expect(view.transformsVersion).toBe(browser.transformsVersion);
});

it.each([-1, .5, NaN])('rejects the same invalid native/browser instance count %s', count => {
  const geometry = createPlaneGeometry(), material = new OpenPBRMaterial();
  expect(() => new InstanceState({count, transforms: new Float32Array(32)})).toThrow(RangeError);
  expect(() => new InstancedMesh(geometry, material, {count, transforms: new Float32Array(32)})).toThrow(RangeError);
});

it.each([[-1, 1], [0, 3], [.5, 1], [1, -1]])('rejects the same invalid instance update range %s/%s', (start, count) => {
  const geometry = createPlaneGeometry(), material = new OpenPBRMaterial();
  for (const state of [new InstanceState({count: 2}), new InstancedMesh(geometry, material, {count: 2})]) {
    expect(() => state.markTransformsUpdated(start, count)).toThrow(RangeError);
    expect(() => state.markColorsUpdated(start, count)).toThrow(RangeError);
    expect(state.version).toBe(0);
  }
});
