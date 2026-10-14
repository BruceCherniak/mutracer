import { afterEach, describe, expect, it, vi } from 'vitest';
import MaterialTable from '../../src/renderer/MaterialTable';
import Material from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import { Texture2DArray, constants } from '../../src/renderer/webgl';
import { envMapDistribution } from '../../src/renderer/envMapDistribution';
import { estimateEnvironmentPower } from '../../src/renderer/lightSampling';
import { float16Bits } from '../../src/renderer/float16';

afterEach(() => { vi.unstubAllGlobals(); });

function context() {
  const values = new Map<PropertyKey, unknown>(Object.entries(constants));
  let next = 0x10000;
  return new Proxy({}, { get(_target, key) {
    if (!values.has(key)) values.set(key, /^[A-Z_0-9]+$/.test(String(key)) ? next++
      : key === 'getParameter' ? vi.fn(() => 4096)
      : key === 'getError' ? vi.fn(() => values.get('NO_ERROR'))
      : vi.fn(() => ({})));
    return values.get(key);
  } }) as WebGL2RenderingContext;
}

describe('raw material atlas uploads', () => {
  it.each([Uint8Array, Uint8ClampedArray])('packs and uploads %s as RGBA8 pixels', ArrayType => {
    const input = new ArrayType([51, 153, 230, 255, 255, 128, 0, 255]);
    const table = new MaterialTable([new Material({map: new Texture({width: 1, height: 2, data: input})})], []);
    expect(table.bufferData.mapColorLinear).toEqual([0]);
    const gl = context(); table.texture!.bind(gl, 0);
    expect(vi.mocked(gl.texImage3D).mock.calls[0].slice(2, 10)).toEqual([gl.RGBA8, 1, 2, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null]);
    const uploaded = vi.mocked(gl.texSubImage3D).mock.calls[0];
    expect(uploaded.slice(2, 10)).toEqual([0, 0, 0, 1, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE]);
    expect(uploaded[10]).toBe(table.texture!.source[0].data);
    expect(Array.from(uploaded[10] as Uint8Array)).toEqual(Array.from(input));
  });

  it('keeps HDR, linear colors and data channels in filterable RGBA16F storage', () => {
    const input = new Float32Array([2, .5, .25, .75]);
    const texture = new Texture({width: 1, height: 1, data: input});
    const table = new MaterialTable([new Material({map: texture, roughnessMap: texture, fuzzColorMap: texture})], []);
    expect(table.defines.NUM_MAPS).toBe(1);
    expect(table.bufferData.mapColorLinear).toEqual([1]);
    expect(table.textureAtlasStats.estimatedBytes).toBe(8);
    expect(table.texture!.storageType).toBe(constants.HALF_FLOAT);
    const gl = context(); table.texture!.bind(gl, 0);
    expect(vi.mocked(gl.texImage3D).mock.calls[0][2]).toBe(gl.RGBA16F);
    expect(vi.mocked(gl.texSubImage3D).mock.calls[0][9]).toBe(gl.HALF_FLOAT);
    expect(Array.from(table.texture!.source[0].data)).toEqual([0x4000, 0x3800, 0x3400, 0x3a00]);
    expect(Array.from(input)).toEqual([2, .5, .25, .75]);
  });

  it('preserves mixed image/raw layers, flipY, alpha, UVs and each logical color space', () => {
    const pixels = new Uint8ClampedArray([255, 128, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const drawImage = vi.fn();
    vi.stubGlobal('document', {createElement: () => ({getContext: () => ({drawImage,
      getImageData: () => ({data: pixels}), save: vi.fn(), translate: vi.fn(), scale: vi.fn(), restore: vi.fn()})})});
    const image = new Texture({width: 1, height: 2} as HTMLCanvasElement);
    const raw = new Texture({width: 1, height: 2, data: new Float32Array([2, .5, 0, .75, 4, 1, 0, .25])});
    raw.flipY = true; raw.uvChannel = 1;
    const table = new MaterialTable([new Material({map: image}), new Material({map: raw})], []);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(table.bufferData.mapColorLinear).toEqual([0, 1]);
    expect(table.bufferData.mapUvChannel).toEqual([0, 1]);
    expect(table.texture!.source.map((p: {data: Uint16Array}) => Array.from(p.data))).toEqual([
      [0x3c00, float16Bits(128 / 255), 0, 0x3c00, 0x4400, 0x3c00, 0, 0x3400,
       0, 0, 0, 0, 0x4000, 0x3800, 0, 0x3a00]
    ]);
  });

  it('budgets float atlases at eight bytes per pixel', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const maps = Array.from({length: 2}, () => new Material({map: new Texture({width: 4, height: 4, data: new Float32Array(64)})}));
    const table = new MaterialTable(maps, [], {maxTextureArrayBytes: 32});
    expect(table.textureAtlasStats.estimatedBytes).toBeLessThanOrEqual(32);
    vi.restoreAllMocks();
  });

  it('rejects incorrect RGBA lengths before upload', () => {
    expect(() => new MaterialTable([new Material({map: new Texture({width: 2, height: 2, data: new Float32Array(15)})})], []))
      .toThrow('RGBA source length');
  });

  it('reports layer upload errors and leaves the texture dirty for a retry', () => {
    const gl = context(); const errors = [gl.NO_ERROR, gl.NO_ERROR, gl.INVALID_OPERATION];
    vi.mocked(gl.getError).mockImplementation(() => errors.shift() ?? gl.NO_ERROR);
    const texture = new Texture2DArray({source: [{width: 1, height: 1, data: new Uint8Array(4)}]});
    expect(() => texture.bind(gl, 0)).toThrow('layer 0');
    texture.bind(gl, 0);
    expect(vi.mocked(gl.texImage3D)).toHaveBeenCalledTimes(2);
  });
});

it.each([
  [0, 0], [-0, 0x8000], [1, 0x3c00], [-2, 0xc000], [65504, 0x7bff], [65520, 0x7c00],
  [Infinity, 0x7c00], [-Infinity, 0xfc00], [NaN, 0x7e00], [2 ** -24, 1],
  [2 ** -25, 0], [3 * 2 ** -25, 2], [2 ** -14, 0x400],
  [1 + 2 ** -11, 0x3c00], [1 + 3 * 2 ** -11, 0x3c02]
])('encodes half-float %s with ties to even', (value, bits) => expect(float16Bits(value)).toBe(bits));

it('normalizes clamped bytes like unsigned bytes in environment sampling', () => {
  const image = {width: 2, height: 1, data: new Uint8Array([51, 153, 230, 255, 204, 102, 77, 255])};
  const clamped = {...image, data: new Uint8ClampedArray(image.data)};
  expect(estimateEnvironmentPower(clamped)).toBe(estimateEnvironmentPower(image));
  expect(envMapDistribution(clamped).data).toEqual(envMapDistribution(image).data);
});

it('uploads matching WebGPU formats and recreates storage on byte/float transitions', async () => {
  vi.stubGlobal('GPUTextureUsage', {TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4});
  const {default: WGPURayTracePass} = await import('../../src/renderer/WGPURayTracePass');
  const pass = Object.create(WGPURayTracePass.prototype) as Record<string, any>;
  const queue = {writeBuffer: vi.fn(), writeTexture: vi.fn()};
  const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => ({
    format: descriptor.format,
    width: (descriptor.size as GPUExtent3DDict).width,
    height: (descriptor.size as GPUExtent3DDict).height,
    depthOrArrayLayers: (descriptor.size as GPUExtent3DDict).depthOrArrayLayers,
    destroy: vi.fn()
  }));
  pass._device = {queue, createTexture, limits: {maxTextureArrayLayers: 256}};
  pass._constants = {NUM_MAPS: 20}; pass._mapInfoUniform = {size: 20 * 48};
  for (const ArrayType of [Uint8Array, Float32Array, Uint8ClampedArray]) {
    const table = new MaterialTable([new Material({map: new Texture({width: 1, height: 1, data: new ArrayType([1, 1, 1, 1])})})], []);
    const old = pass._maps;
    pass._updateTextures(table);
    if (old) expect(old.destroy).toHaveBeenCalledOnce();
    const float = ArrayType === Float32Array;
    expect(pass._maps.format).toBe(float ? 'rgba16float' : 'rgba8unorm');
    const upload = queue.writeTexture.mock.calls.at(-1)!;
    expect(upload[1]).toBe(table.texture!.source[0].data);
    expect(upload[2]).toEqual({bytesPerRow: float ? 8 : 4, rowsPerImage: 1});
    const metadata = queue.writeBuffer.mock.calls.at(-1)![2] as Float32Array;
    expect(metadata[20 * 8 + 1]).toBe(Number(float));
  }
  expect(createTexture).toHaveBeenCalledTimes(3);
});
