import { expect, it } from 'vitest';
import OpenPBRMaterial, { materialKeys, materialTextureKeys, materialGeometryKeys, materialParamKeys } from '../../src/scene/OpenPBRMaterial';

it('versions material edits and exhaustively classifies independent property groups', () => {
  const material = new OpenPBRMaterial();
  expect(material.version).toBe(0);
  expect(material.markUpdated()).toBe(material);
  expect(material.version).toBe(1);
  const grouped = [...materialTextureKeys, ...materialGeometryKeys, ...materialParamKeys];
  expect(new Set(grouped).size).toBe(grouped.length);
  expect([...grouped].sort()).toEqual([...materialKeys].sort());
  expect(Object.keys(material).filter(key => key !== 'version').sort()).toEqual([...materialKeys].sort());
});
