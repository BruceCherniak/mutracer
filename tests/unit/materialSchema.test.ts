import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Material, { getMaterialHashKey, materialKeys } from '../../src/scene/OpenPBRMaterial';
import { openPbrSchema } from '../../src/scene/openPbrSchema';
import Texture from '../../src/scene/Texture';
import MaterialTable from '../../src/renderer/MaterialTable';
import baseline from '../fixtures/material-schema-baseline.json';

function fixedMaterials() {
  const textures = [0,1].map(i => new Texture({width:2,height:2,data:new Uint8Array(16).fill(80 + i*60)}));
  textures[0].uvScale = [2,3]; textures[0].uvOffset = [.1,.2]; textures[1].uvChannel = 1; textures[1].markUpdated();
  const base = new Material();
  const enums: Record<string, string> = {alphaMode:'mask', mapAlphaUsage:'transmission', uvProjection:'triplanar', displacementUvProjection:'spherical'};
  const params = Object.fromEntries(baseline.keys.map((key,i) => {
    const value = base[key as keyof Material];
    return [key, key.endsWith('Map') || key === 'map' ? textures[i%2] : enums[key] ??
      (Array.isArray(value) ? value.map((_v,j) => .2+j*.1) : typeof value === 'boolean' ? true : .25+i*.013)];
  }));
  return [base,new Material({...params,shadowCatcher:false,unlit:false}),
    new Material({...params,transmissionWeight:0,subsurfaceWeight:1,shadowCatcher:true}),
    new Material({...params,shadowCatcher:false,unlit:true})];
}

describe('OpenPBR schema', () => {
  it('covers every material field with matching defaults and independent array storage', () => {
    const material = new Material(); const other = new Material();
    expect(Object.keys(material).filter(key => key !== 'version').sort()).toEqual([...materialKeys].sort());
    expect(new Set(materialKeys).size).toBe(materialKeys.length);
    for (const field of openPbrSchema) {
      expect(material[field.key]).toEqual(field.default);
      if (Array.isArray(material[field.key])) {
        expect(material[field.key]).not.toBe(other[field.key]);
        expect(material[field.key]).not.toBe(field.default);
      }
    }
  });
  it('retains the fixed packing bytes and hash order including coat emission', () => {
    const materials = fixedMaterials(); const data = new MaterialTable(materials, []);
    const bytes = Buffer.from(data.getBufferArray().buffer);
    expect(materialKeys.slice(0, baseline.keys.length)).toEqual(baseline.keys);
    expect(materialKeys.slice(baseline.keys.length)).toEqual(['thinFilmThicknessMinimum', 'thinFilmMapChannel', 'coatWeightMap', 'coatRoughnessMap', 'fuzzColorMap', 'fuzzRoughnessMap', 'specularWeightMap', 'specularColorMap', 'anisotropyMap', 'specularAnisotropyRotation', 'coatAnisotropyRotation', 'specularAnisotropyModel']);
    expect(materials.map(getMaterialHashKey)).toEqual(baseline.hashes.map(hash => `${hash}_0_r_$_$_$_$_$_$_$_0_0_openpbr`));
    // C1 migrates only the seven obsolete reserved scalars and stride.
    // Historical keys/hash prefix and every effective field stay fixed.
    expect(bytes).toEqual(Buffer.from(baseline.packedBase64, 'base64'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(baseline.sha256);
    // Undo just the approved reserved-slot migration and added rows. The
    // pre-C1 effective payload must retain its independent historical digest.
    const legacy = Buffer.concat(materials.map((_m, i) => {
      const prefix = Buffer.from(bytes.subarray(i * 416, i * 416 + 384));
      for (const offset of [96, 100, 104, 108, 300, 316, 348]) prefix.writeFloatLE(0, offset);
      return prefix;
    }));
    expect(createHash('sha256').update(legacy).digest('hex')).toBe('bffe8ec5286e64b53b0fb35b542b8096b0a6ef0930c4c2d15266daf1b3b59a8c');
  });
  for (const field of openPbrSchema.filter(field => field.category === 'param')) {
    it(`packs ${field.key}`, () => {
      const material = new Material({emissionLuminance: 1, transmissionWeight: 1, transmissionDepth: 1});
      const before = new MaterialTable([material], []).getBufferArray();
      const value = field.default;
      const enums: Record<string, string> = {alphaMode: 'blend', mapAlphaUsage: 'transmission', uvProjection: 'triplanar', thinFilmMapChannel: 'g', specularAnisotropyModel: 'gltf'};
      const changed = field.type === 'enum' ? enums[field.key] : Array.isArray(value) ? value.map(v => v * .3 + .1) :
        typeof value === 'boolean' ? !value : (material[field.key] as number) + .2;
      Object.assign(material, {[field.key]: changed});
      const packed = new MaterialTable([material], []);
      expect(packed.getBufferArray()).not.toEqual(before);
      const fresh = packed.getBufferArray();
      Object.assign(material, {[field.key]: field.default});
      packed.repackParams([material]);
      expect(packed.getBufferArray()).not.toEqual(fresh);
    });
  }
  it('ignores undefined constructor overrides and preserves supplied identities', () => {
    const texture = new Texture({width:1,height:1,data:new Uint8Array(4)});
    const color: [number,number,number] = [.2,.3,.4];
    const material = new Material({baseWeight: undefined, baseColor: color, map: texture});
    expect(material.baseWeight).toBe(1); expect(material.baseColor).toBe(color); expect(material.map).toBe(texture);
  });
});
