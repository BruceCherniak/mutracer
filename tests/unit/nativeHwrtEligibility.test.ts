import {expect, it} from 'vitest';
import MaterialState from '../../src/scene/MaterialState.js';
import PixelTexture from '../../src/scene/PixelTexture.js';
import {hardwareOpaqueGeometryFlags} from '../../native/hwrt-eligibility.js';

const opaque = () => new MaterialState({doubleSided: true, alphaMode: 'opaque'});
it('requires every instance sharing a geometry to permit unfiltered hits', () => {
  const materials = [opaque(), new MaterialState({doubleSided: false}), opaque()];
  expect(hardwareOpaqueGeometryFlags(materials, [
    {blasIndex: 0, materialIndices: [0]}, {blasIndex: 0, materialIndices: [1]},
    {blasIndex: 1, materialIndices: [2]}
  ], 3)).toEqual([false, true, false]);
});
it('disqualifies an entire material table when one entry needs alpha filtering', () => {
  const materials = [opaque(), new MaterialState({doubleSided: true, alphaMode: 'mask'})];
  expect(hardwareOpaqueGeometryFlags(materials, [{blasIndex: 0, materialIndices: [0, 1]}], 1)).toEqual([false]);
});
it('uses the shared auto-alpha rule and preserves explicit opaque coverage', () => {
  const alpha = new MaterialState({doubleSided: true, geometryOpacity: .5});
  const explicit = new MaterialState({doubleSided: true, geometryOpacity: .5, alphaMode: 'opaque'});
  expect(hardwareOpaqueGeometryFlags([alpha, explicit], [
    {blasIndex: 0, materialIndices: [0]}, {blasIndex: 1, materialIndices: [1]}
  ], 2)).toEqual([false, true]);
});
it('keeps displacement geometry on the candidate path even with zero scale', () => {
  const material = opaque();
  material.displacementMap = new PixelTexture({width: 1, height: 1, data: new Uint8Array(4)});
  material.displacementScale = 0;
  expect(hardwareOpaqueGeometryFlags([material], [{blasIndex: 0, materialIndices: [0]}], 1)).toEqual([false]);
});
