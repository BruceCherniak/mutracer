import { expect, it, vi } from 'vitest';
import { Texture2D } from '../../src/renderer/webgl';
import { setDataTexture, commonNearestFloatProps } from '../../src/renderer/dataTextureUtil';

function context() {
  const values = new Map<PropertyKey, unknown>(); let constant = 1;
  return new Proxy({}, { get(_target, key) {
    if (!values.has(key)) values.set(key, /^[A-Z_0-9]+$/.test(String(key)) ? constant++ : key === 'createTexture' ? vi.fn(() => ({})) : vi.fn());
    return values.get(key);
  } }) as WebGL2RenderingContext;
}
it('copies just the edited bytes and uploads complete covering rows, including padding', () => {
  const gl = context(), texture = new Texture2D(commonNearestFloatProps);
  const data = Float32Array.from({length: 76}, (_, i) => i);
  const { columns } = setDataTexture(texture, data, 4);
  texture.bind(gl, 0);
  data.fill(-1, 15, 22); data[2] = 999;
  texture.updateDataRange(gl, data, 15 * 4, 7 * 4);
  expect(texture.source.data[2]).toBe(2);
  expect(Array.from(texture.source.data.slice(15, 22))).toEqual(Array(7).fill(-1));
  const calls = vi.mocked(gl.texSubImage2D).mock.calls;
  expect(calls).toHaveLength(1);
  const first = Math.floor(15 / (columns * 4)), end = Math.ceil(22 / (columns * 4));
  expect(calls[0].slice(2, 6)).toEqual([0, first, columns, end - first]);
  expect(calls[0][8]).toEqual(texture.source.data.subarray(first * columns * 4, end * columns * 4));
  texture.updateDataRange(gl, data, 75 * 4, 4);
  const last = calls[1][8] as Float32Array;
  expect(last.at(-1)).toBe(0); // final padded texel survives
  expect(vi.mocked(gl.texImage2D).mock.calls).toHaveLength(1);
  expect(() => texture.updateDataRange(gl, data, 1, 4)).toThrow(RangeError);
});
it('applies queued edits before the first full allocation', () => {
  const gl = context(), texture = new Texture2D(commonNearestFloatProps);
  const data = new Float32Array(32); setDataTexture(texture, data, 4);
  data[10] = 3; texture.updateDataRange(gl, data, 40, 4);
  expect(texture.source.data[10]).toBe(3);
  expect(vi.mocked(gl.texImage2D).mock.calls).toHaveLength(1);
  expect(vi.mocked(gl.texSubImage2D).mock.calls).toHaveLength(0);
});
