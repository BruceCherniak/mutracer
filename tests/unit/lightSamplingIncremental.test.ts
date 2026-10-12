import { expect, it } from 'vitest';
import { buildLightAliasTable, LightChoiceBuffer, LightChoiceInput, LightSamplingDistribution,
  EmissiveTriangleCache, collectEmissiveTriangles, packEmissiveTriangles, estimateEnvironmentPower } from '../../src/renderer/lightSampling';
import { createPlaneGeometry } from '../../src/util/commonGeometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';

// Previous object/number-array implementation, retained as the numerical contract.
function referenceAlias(
  inputs: LightChoiceInput[]
): LightSamplingDistribution {
  const active = inputs.filter((input) => input.weight > 0 && isFinite(input.weight));
  const totalWeight = active.reduce((sum, input) => sum + input.weight, 0);
  const count = active.length;
  if (!count || !(totalWeight > 0)) {
    return {
      choices: new Uint32Array(4),
      pmfs: new Float32Array(0),
      totalWeight: 0
    };
  }

  const pmfs = Float32Array.from(active, (input) => input.weight / totalWeight);
  const scaled = Array.from(pmfs, (pmf) => pmf * count);
  const probabilities = new Float32Array(count);
  const aliases = new Int32Array(count);
  const small: number[] = [];
  const large: number[] = [];
  scaled.forEach((value, index) => (value < 1 ? small : large).push(index));

  while (small.length && large.length) {
    const low = small.pop()!;
    const high = large.pop()!;
    probabilities[low] = scaled[low];
    aliases[low] = high;
    scaled[high] = scaled[high] + scaled[low] - 1;
    (scaled[high] < 1 ? small : large).push(high);
  }
  for (const index of [...small, ...large]) {
    probabilities[index] = 1;
    aliases[index] = index;
  }

  const buffer = new ArrayBuffer(count * 16);
  const floatView = new Float32Array(buffer);
  const intView = new Int32Array(buffer);
  active.forEach((input, index) => {
    const offset = index * 4;
    floatView[offset] = probabilities[index];
    intView[offset + 1] = aliases[index];
    intView[offset + 2] = input.sourceType;
    intView[offset + 3] = input.sourceIndex;
  });
  return { choices: new Uint32Array(buffer), pmfs, totalWeight };
}

const bits = (a: Float32Array | Uint32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);
it('matches the previous alias table bit for bit over seeded distributions', () => {
  let seed = 0x12345678;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  for (let run = 0; run < 80; run++) {
    const inputs = Array.from({length: run * 7}, (_, i) => ({sourceType: i % 3 + 1, sourceIndex: i,
      weight: i % 17 === 0 ? NaN : i % 13 === 0 ? Infinity : i % 11 === 0 ? 0 : random() * 10 ** (random() * 20 - 10)}));
    const typed = new LightChoiceBuffer(); typed.reserve(inputs.length);
    for (const input of inputs) typed.push(input.sourceType, input.sourceIndex, input.weight);
    const old = referenceAlias(inputs);
    for (const next of [buildLightAliasTable(inputs), buildLightAliasTable(typed)]) {
      expect(bits(next.choices)).toEqual(bits(old.choices)); expect(bits(next.pmfs)).toEqual(bits(old.pmfs));
      expect(next.totalWeight).toBe(old.totalWeight);
    }
  }
});
it('retains world vertices for strength edits and recollects only the changed binding', () => {
  const materials = Array.from({length: 3}, (_, i) => Object.assign(new OpenPBRMaterial(), {emissionLuminance: i + 1}));
  const bindings = materials.map((m, i) => { const mesh = new Mesh(createPlaneGeometry(), m); mesh.transform[12] = i * 3; return {mesh, geometry: mesh.geometry, materialIndices: [i]}; });
  const cache = new EmissiveTriangleCache();
  const first = cache.collect(bindings, materials).slice();
  for (let frame = 0; frame < 20; frame++) {
    materials[1].emissionLuminance += .17;
    if (frame % 4 === 0) bindings[0].mesh.transform[13] += .1;
    if (frame % 7 === 0) { bindings[2].geometry.position.array[0] += .01; bindings[2].geometry.markUpdated(); }
    const expected = collectEmissiveTriangles(bindings, materials), actual = cache.collect(bindings, materials);
    expect(actual[2].p0).toBe(first[2].p0);
    // Exercise PMF packing too; both algorithms receive the same Float32 PMFs.
    const pmfs = buildLightAliasTable(actual.map((t, i) => ({sourceType: 3,sourceIndex:i,weight:t.area*t.samplingLuminance}))).pmfs;
    actual.forEach((t,i) => t.selectionPmf = expected[i].selectionPmf = pmfs[i]);
    expect(bits(packEmissiveTriangles(actual))).toEqual(bits(packEmissiveTriangles(expected)));
  }
  materials[1].emissionLuminance = 0;
  expect(packEmissiveTriangles(cache.collect(bindings, materials)).length).toBe(packEmissiveTriangles(collectEmissiveTriangles(bindings, materials)).length);
});
it('reads an unchanged environment image only once and recomputes new images', () => {
  let reads = 0; const data = new Float32Array([.2,.3,.4,1]);
  const image = {width:1,height:1,get data(){reads++; return data;}};
  const power = estimateEnvironmentPower(image), firstReads = reads;
  expect(estimateEnvironmentPower(image)).toBe(power); expect(reads - firstReads).toBe(1); // validity guard only
  data[0] = 2;
  expect(estimateEnvironmentPower(image)).toBe(power);
  expect(estimateEnvironmentPower({...image})).toBeGreaterThan(power);
});
