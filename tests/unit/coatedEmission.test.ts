import { describe, expect, it } from 'vitest';
import MaterialTable from '../../src/renderer/MaterialTable';
import { collectEmissiveTriangles, EmissiveTriangleCache, colorLuminance, buildLightAliasTable } from '../../src/renderer/lightSampling';
import { materialIsEmissive } from '../../src/renderer/materialChanges';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Mesh from '../../src/scene/Mesh';
import { createPlaneGeometry } from '../../src/util/commonGeometry';

describe('coat attenuation of emission and MIS selection', () => {
  const makeBindings = (materials: OpenPBRMaterial[]) => materials.map((m, i) => {
    const mesh = new Mesh(createPlaneGeometry(), m);
    return {mesh, geometry: mesh.geometry, materialIndices: [i]};
  });
  it.each([0, 0.5, 1])('uses one passage for coat coverage %s in packing and light power', coatWeight => {
    const m = new OpenPBRMaterial({emissionColor: [1, 1, 1], emissionLuminance: 2,
      coatWeight, coatColor: [0.81, 0.25, 0.04]});
    const expected = [2 * (1 - 0.1 * coatWeight), 2 * (1 - 0.5 * coatWeight), 2 * (1 - 0.8 * coatWeight)];
    const table = new MaterialTable([m], []);
    table.bufferData.emission[0].forEach((v,i) => expect(v).toBeCloseTo(expected[i], 12));
    const packedEmission = table.getBufferArray().slice(12, 15); // same RGB read by emissiveHitMisWeight
    const triangles = collectEmissiveTriangles(makeBindings([m]), [m]);
    for (const tri of triangles) {
      expect(tri.samplingLuminance).toBeCloseTo(colorLuminance(expected), 12);
      expect(tri.samplingLuminance).toBeCloseTo(colorLuminance(packedEmission), 7);
    }
  });
  it('updates cached power and alias PMFs, removing and restoring fully absorbed emitters', () => {
    const coated = new OpenPBRMaterial({emissionLuminance: 2, coatWeight: 1, coatColor: [0.25, 0.25, 0.25]});
    const bare = new OpenPBRMaterial({emissionLuminance: 2});
    const materials = [coated, bare], bindings = makeBindings(materials), cache = new EmissiveTriangleCache();
    const first = cache.collect(bindings, materials).slice();
    const distribution = buildLightAliasTable(first.map((t,i) => ({sourceType: 3, sourceIndex: i, weight: t.area * t.samplingLuminance})));
    expect(distribution.pmfs[0]).toBeCloseTo(1/6);
    expect(distribution.pmfs[2]).toBeCloseTo(1/3);
    coated.coatColor = [0.04, 0.04, 0.04];
    const second = cache.collect(bindings, materials);
    expect(second[0].p0).toBe(first[0].p0);
    expect(second[0].samplingLuminance).toBeCloseTo(0.4);
    expect(second).toEqual(collectEmissiveTriangles(bindings, materials));
    coated.coatColor = [0,0,0];
    expect(materialIsEmissive(coated)).toBe(false);
    expect(cache.collect(bindings, materials)).toHaveLength(2);
    coated.coatWeight = 0;
    expect(materialIsEmissive(coated)).toBe(true);
    expect(cache.collect(bindings, materials)).toHaveLength(4);
  });
  it.each(['unlit','shadowCatcher'] as const)('keeps %s emission independent of coat', flag => {
    const m = new OpenPBRMaterial({[flag]: true, emissionColor: [1,0.5,0.25], emissionLuminance: 2, coatWeight: 1, coatColor: [0,0,0]});
    expect(new MaterialTable([m], []).bufferData.emission[0]).toEqual([2,1,0.5]);
  });
});
