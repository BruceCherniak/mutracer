import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import ts from 'typescript';
import {specializeStorageSource} from '../../native/storage-lowering.mjs';
import {writeRawAtlasPlacement} from '../../src/renderer/textureAtlasPixels.js';
import {float16Bits} from '../../src/renderer/float16.js';
import {envMapDistribution} from '../../src/renderer/envMapDistribution.js';

const formats = [Uint8Array, Uint8ClampedArray, Float32Array, Int32Array];
function evaluate(source: string) {
  const exports: Record<string, (...args: any[]) => any> = {};
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  new Function('require', 'exports', code)((name: string) => {
    if (name.endsWith('float16.js')) return {float16Bits};
    throw new Error(`Unexpected kernel dependency: ${name}`);
  }, exports);
  return exports;
}
const atlasSource = readFileSync(new URL('../../src/renderer/textureAtlasPixels.ts', import.meta.url), 'utf8');
const atlas = evaluate(specializeStorageSource(atlasSource, 'writeRawAtlasPlacement', 'texture', formats.map(T => T.name), true));
const environment = evaluate(specializeStorageSource(readFileSync(new URL('../../src/renderer/envMapDistribution.ts', import.meta.url), 'utf8'),
  'environmentLuminance', 'data', formats.map(T => T.name)));

describe('native storage kernels from shared TypeScript', () => {
  it.each(formats)('preserves %s atlas conversion, offsets, resizing and orientation', Type => {
    const backing = new Type([99, 0, 1, 63, 127, 128, 129, 200, 255, 256, -1, .5, 65504, 2 ** -24, 3, 4, 5, 11, 22, 33, 44, 55, 66, 77, 88, 99]);
    const input = backing.subarray(1, 25);
    for (const Output of [Uint8Array, Uint16Array]) for (const floatStorage of [false, true]) for (const flipY of [false, true]) for (const [width, height] of [[1, 1], [3, 2], [5, 4]]) {
      const placement = {x: 1, y: 1, width, height, index: 0, layer: 0};
      const expected = new Output((width + 3) * (height + 2) * 4).fill(17), actual = expected.slice();
      const texture = {image: {width: 3, height: 2, data: input}, flipY};
      writeRawAtlasPlacement(expected, width + 3, placement, texture, floatStorage);
      atlas.writeRawAtlasPlacement(actual, width + 3, placement, texture, floatStorage);
      expect(actual).toEqual(expected);
    }
  });
  it('retains overlapping-buffer order and invalid RGBA length rejection', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 0]), b = a.slice();
    const placement = {x: 1, y: 0, width: 2, height: 1, index: 0, layer: 0};
    writeRawAtlasPlacement(a, 3, placement, {image: {width: 2, height: 1, data: a.subarray(0, 8)}, flipY: false}, false);
    atlas.writeRawAtlasPlacement(b, 3, placement, {image: {width: 2, height: 1, data: b.subarray(0, 8)}, flipY: false}, false);
    expect(b).toEqual(a);
    expect(() => atlas.writeRawAtlasPlacement(b, 3, placement, {image: {width: 2, height: 1, data: new Uint8Array(7)}, flipY: false}, false)).toThrow('RGBA source length');
  });
  it.each(formats)('preserves %s environment filtering, normalization and cache invalidation', Type => {
    const data = new Type([1, 2, 3, 255, 255, 200, 100, 255, 0, 0, 0, 255, 32, 64, 96, 255]);
    const input = {width: 2, height: 2, data, distributionCacheVersion: 0};
    const expected = envMapDistribution(input), actual = environment.envMapDistribution(input);
    expect(actual.data).toEqual(expected.data);
    expect(environment.envMapDistribution({...input})).toBe(actual);
    data[0] = 99; input.distributionCacheVersion++;
    expect(environment.envMapDistribution(input).data).toEqual(envMapDistribution(input).data);
  });
  it('preserves finite validation for typed arrays, ordinary arrays and non-finite values', () => {
    const source = 'export function finiteValues(values: Float32Array | Float64Array | number[]): boolean { const length = values.length; for(let i=0;i<length;i++) if(!Number.isFinite(read(values,i))) return false; return true; }';
    const lowered = evaluate(specializeStorageSource(source, 'finiteValues', 'values', ['Float32Array', 'Float64Array', 'number[]']));
    for (const Type of [Float32Array, Float64Array, Array]) for (const values of [[], [1, -2, 3], [NaN], [Infinity], [-Infinity]]) {
      const data = Type === Float32Array ? new Float32Array(values) : Type === Float64Array ? new Float64Array(values) : values;
      expect(lowered.finiteValues(data)).toBe(values.every(Number.isFinite));
    }
  });
});
