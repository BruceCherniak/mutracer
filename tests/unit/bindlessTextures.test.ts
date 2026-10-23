import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import Texture from '../../src/scene/Texture';
import Material from '../../src/scene/OpenPBRMaterial';
import RectLight from '../../src/scene/RectLight';
import MaterialData from '../../src/renderer/MaterialData';
import {WGPUBindlessMaterialData} from '../../src/renderer/WGPUBindlessMaterialData';
import {independentTexturePixels, packIndependentTextureInfo, planIndependentTextures, WGPUBindlessTextures} from '../../src/renderer/WGPUBindlessTextures';
import {bindlessLimitReason, resourceTableFeature} from '../../src/renderer/wgpuBindless';

const texture = (width = 2, height = 1) => new Texture({width, height, data: new Uint8Array(width * height * 4).fill(255)});
beforeEach(() => {
  vi.stubGlobal('GPUTextureUsage', {TEXTURE_BINDING: 1, COPY_DST: 2});
  vi.stubGlobal('GPUBufferUsage', {STORAGE: 1, COPY_DST: 2});
});
afterEach(() => {vi.unstubAllGlobals();});

it('keeps material packing, deduplication, displacement and light indices compatible with the shared CPU core', () => {
  const a = texture(), b = texture();
  const materials = [new Material({map: a, normalMap: a, displacementMap: b}), new Material({map: a, coatWeightMap: b})];
  const light = new RectLight({texture: a});
  const actual = new WGPUBindlessMaterialData(materials, [light]);
  const reference = new MaterialData(materials, [a], () => 0);
  expect(actual.getBufferArray()).toEqual(reference.getBufferArray());
  expect(actual.defines).toEqual(reference.defines);
  expect(actual.textures).toEqual(reference.textures);
  expect(actual.getLightTexturesIndices()).toEqual(reference.lightTexturesIndices);
  expect(actual.getDisplacementMaps()).toEqual(reference.displacementMaps);
  materials[0].baseMetalness = .7; actual.repackParams(materials); reference.repackParams(materials);
  expect(actual.getBufferArray()).toEqual(reference.getBufferArray());
});
it('packs integer resource indices separately from UV floats, with all independent wrap combinations', () => {
  const modes = ['repeat', 'clamp-to-edge', 'mirrored-repeat'] as const;
  const textures = modes.flatMap(wrapS => modes.map(wrapT => {
    const t = texture(); t.wrapS = wrapS; t.wrapT = wrapT; t.uvScale = [2,3]; t.uvOffset = [-1,.5]; t.uvChannel = 1; return t;
  }));
  const data = packIndependentTextureInfo(textures, textures.map(t => t.image), 16);
  for (let i = 0; i < textures.length; i++) {
    expect([...new Float32Array(data, i * 48, 4)]).toEqual([2,3,-1,.5]);
    expect([...new Uint32Array(data, i * 48 + 16, 8)]).toEqual([10+i,1+i,1,0,2,1,0,0]);
  }
  expect([...new Uint32Array(data, 9 * 48)]).toEqual(Array((16-9)*12).fill(0));
});
it('fits a uniform scale to byte and dimension limits without allocating an atlas', () => {
  const a = texture(16,8), b = texture(8,16);
  const plan = planIndependentTextures([a,b], 64*4, 32);
  expect(plan.estimatedBytes).toBeLessThanOrEqual(256);
  expect(plan.scale).toBeLessThan(1);
  expect(plan.sizes).toEqual([{width:8,height:4},{width:4,height:8}]);
  expect(planIndependentTextures([a], 1e6, 4).sizes).toEqual([{width:4,height:2}]);
  expect(() => planIndependentTextures([a,b], 7, 32)).toThrow('1×1');
  expect(planIndependentTextures([], 0, 32).estimatedBytes).toBe(0);
});
it('retains raw HDR precision, nearest resizing, flipY and whole-scene float promotion', () => {
  const t = new Texture({width:1,height:2,data:new Float32Array([2,0,0,1,4,0,0,1])}); t.flipY = true;
  expect([...independentTexturePixels(t,{width:1,height:2},true)]).toEqual([0x4400,0,0,0x3c00,0x4000,0,0,0x3c00]);
  const byte = texture();
  expect(planIndependentTextures([byte,t], 1000, 32).bytesPerPixel).toBe(8);
  expect([...independentTexturePixels(byte,{width:1,height:1},false)]).toEqual([255,255,255,255]);
  expect(() => independentTexturePixels(new Texture({width:2,height:1,data:new Uint8Array(4)}),{width:2,height:1},false)).toThrow('length');
});

function fakeDevice() {
  const textures: {width:number;height:number;format:string;destroy:ReturnType<typeof vi.fn>}[] = [];
  let complete!: () => void;
  const device = {
    limits: {maxStorageBuffersPerShaderStage:16,maxStorageBufferBindingSize:1e6,maxBufferSize:1e6,maxTextureDimension2D:8192},
    createSampler: vi.fn(() => ({})),
    createResourceTable: vi.fn(({size}) => ({size,update:vi.fn(),destroy:vi.fn()})),
    createBuffer: vi.fn(({size}) => ({size,destroy:vi.fn()})),
    createTexture: vi.fn(({size,format}) => {
      const t = {width:size[0],height:size[1],format,destroy:vi.fn(),createView:vi.fn(() => ({}))}; textures.push(t); return t;
    }),
    queue: {writeTexture:vi.fn(),writeBuffer:vi.fn(),onSubmittedWorkDone:vi.fn(() => new Promise<void>(resolve => {complete=resolve;}))}
  };
  return {device:device as unknown as GPUDevice, mock:device, textures, complete: () => complete()};
}
it('updates only changed pixels and leaves resource descriptors alone for metadata edits', () => {
  const {device,mock} = fakeDevice(), manager = new WGPUBindlessTextures(device);
  const a=texture(),b=texture(); manager.update([a,b],1000);
  const table = manager.table; mock.queue.writeTexture.mockClear(); mock.createTexture.mockClear();
  a.uvOffset = [.1,.2]; a.wrapS = 'mirrored-repeat'; a.colorSpace = 'linear'; manager.update([a,b],1000);
  expect(mock.queue.writeTexture).not.toHaveBeenCalled(); expect(mock.createTexture).not.toHaveBeenCalled(); expect(manager.table).toBe(table);
  a.markUpdated(); manager.update([a,b],1000);
  expect(mock.queue.writeTexture).toHaveBeenCalledOnce(); expect(manager.table).toBe(table);
  manager.dispose();
});
it('retains old descriptors and removed textures until completion, and bounds outstanding generations', async () => {
  const fake = fakeDevice(), manager = new WGPUBindlessTextures(fake.device), a=texture();
  manager.update([a],1000); const oldTable=manager.table!, oldTexture=fake.textures[1];
  a.image={width:4,height:1,data:new Uint8Array(16)}; manager.update([a],1000);
  expect(oldTable.destroy).not.toHaveBeenCalled(); expect(oldTexture.destroy).not.toHaveBeenCalled();
  expect(manager.diagnostics.retiredBytes).toBeGreaterThan(0);
  expect(() => manager.update([a],1000)).toThrow('retired');
  const retirement=manager.retirement; fake.complete(); await retirement;
  expect(oldTable.destroy).toHaveBeenCalledOnce();expect(oldTexture.destroy).toHaveBeenCalledOnce();
  expect(manager.diagnostics.retiredBytes).toBe(0); manager.update([a],1000); manager.dispose(); manager.dispose();
  expect(fake.textures.every(t=>t.destroy.mock.calls.length===1)).toBe(true);
});
it('reuses a GPU texture when logical light/material entries share an image object', () => {
  const fake=fakeDevice(), manager=new WGPUBindlessTextures(fake.device), a=texture();
  manager.update([a,a],1000);
  expect(fake.mock.createTexture).toHaveBeenCalledTimes(2); // fallback and one source
  expect(manager.diagnostics.textureCount).toBe(2);expect(manager.diagnostics.estimatedBytes).toBe(8);
  manager.dispose();
});
it('detects resource features and keeps extra limits local to the optional path', () => {
  expect(resourceTableFeature(new Set() as GPUSupportedFeatures)).toBeUndefined();
  expect(resourceTableFeature(new Set(['chromium-experimental-sampling-resource-table']) as GPUSupportedFeatures)?.enable).toBe('chromium_experimental_resource_table');
  const {device,mock}=fakeDevice();expect(bindlessLimitReason(device)).toBeUndefined();
  expect(bindlessLimitReason(device,65527)).toContain('slot');
  mock.limits.maxStorageBuffersPerShaderStage=8;expect(bindlessLimitReason(device)).toContain('9 storage');
});
