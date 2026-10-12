import {afterEach, expect, it, vi} from 'vitest';
import {makeShaderDataDefinitions} from 'webgpu-utils';
import {WGPUFullQuadPass} from '../../src/renderer/WGPUFullQuadPass';
import {WGPUComputePass} from '../../src/renderer/WGPUComputePass';
import {ScratchPool} from '../../src/renderer/ScratchPool';
import {setTextureRegion, textureRegion} from '../../src/renderer/textureRegion';
afterEach(() => {vi.unstubAllGlobals();});
function gpu() {
  vi.stubGlobal('GPUBufferUsage', {UNIFORM: 1, COPY_DST: 2, STORAGE: 4, COPY_SRC: 8});
  vi.stubGlobal('GPUTextureUsage', {RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4});
  vi.stubGlobal('GPUShaderStage', {VERTEX: 1, FRAGMENT: 2, COMPUTE: 4});
  const device = {
    createBuffer: vi.fn((options: GPUBufferDescriptor) => ({size: options.size, destroy: vi.fn()})),
    queue: {writeBuffer: vi.fn((_buffer: GPUBuffer, _offset: number, _data: BufferSource) => {}), onSubmittedWorkDone: async () => {}},
    createTexture: vi.fn((options: GPUTextureDescriptor) => ({...options.size, depthOrArrayLayers: 1, format: options.format, createView: () => ({}), destroy: vi.fn()})),
    createShaderModule: vi.fn((_descriptor: GPUShaderModuleDescriptor) => ({})), createRenderPipeline: vi.fn(() => ({getBindGroupLayout: () => ({})})), createBindGroup: vi.fn(() => ({}))
  };
  const render = {setViewport: vi.fn(), setScissorRect: vi.fn(), setPipeline() {}, setBindGroup() {}, draw() {}, end() {}};
  const encoder = {beginRenderPass: () => render} as unknown as GPUCommandEncoder;
  return {device: device as unknown as GPUDevice, calls: device, render, encoder};
}
it('reuses a large texture for smaller images and keeps the active viewport bounded', () => {
  const {device, calls, render, encoder} = gpu();
  const pass = new WGPUFullQuadPass('scratch', device, {inputs: ['input'], outputs: ['color'], fsMain: 'output.color = textureLoad(input, uv, 0);'});
  pass.reserveCapacity(); pass.setOutputParams({color: {format: 'rgba32float'}});
  const input = {width: 64, height: 64, createView: () => ({})} as GPUTexture;
  pass.setSize(64, 64); pass.createPass(encoder, {input}); const allocated = pass.getOutput('color');
  pass.setSize(32, 16); pass.createPass(encoder, {input});
  expect(pass.getOutput('color')).toBe(allocated); expect(textureRegion(allocated)).toEqual({width: 32, height: 16});
  expect(render.setViewport).toHaveBeenLastCalledWith(0, 0, 32, 16, 0, 1);
  expect(render.setScissorRect).toHaveBeenLastCalledWith(0, 0, 32, 16);
  pass.setSize(64, 64); pass.createPass(encoder, {input}); expect(calls.createTexture).toHaveBeenCalledOnce(); pass.dispose();
});
it('packs texture regions into one uniform binding within minimum device limits', () => {
  const {device, calls, encoder} = gpu();
  const pass = new WGPUFullQuadPass('six inputs', device, {inputs: ['a', 'b', 'c', 'd', 'e', 'f'], outputs: ['color'],
    uniforms: Array.from({length: 9}, (_, i) => ({label: `value${i}`, type: 'f32' as const, data: 0})),
    fsMain: 'output.color = textureLoad(a, uv, 0) + textureLoad(b, uv, 0) + textureLoad(c, uv, 0) + textureLoad(d, uv, 0) + textureLoad(e, uv, 0) + textureLoad(f, uv, 0);'});
  pass.reserveCapacity(); pass.setSize(32, 32); pass.setOutputParams({color: {format: 'rgba8unorm'}});
  const texture = {width: 64, height: 64, createView: () => ({})} as GPUTexture; setTextureRegion(texture, 32, 16);
  pass.createPass(encoder, {a: texture, b: texture, c: texture, d: texture, e: texture, f: texture});
  const code = calls.createShaderModule.mock.calls.map(([descriptor]) => (descriptor as unknown as GPUShaderModuleDescriptor).code).find(code => code.includes('@fragment'))!;
  const uniforms = makeShaderDataDefinitions(code).uniforms;
  expect(Object.keys(uniforms).length).toBeLessThanOrEqual(12); expect(uniforms.imageRegions.size).toBe(6 * 16);
  const values = calls.queue.writeBuffer.mock.calls.find(call => call[2] instanceof Uint32Array && call[2].length === 24)![2];
  expect(Array.from(values as Uint32Array)).toEqual(Array.from({length: 6}, () => [32, 16, 0, 0]).flat()); pass.dispose();
});
it('retains compute storage across alternating image sizes', () => {
  const {device, calls} = gpu(); const pass = new WGPUComputePass('scratch', device, {inputs: [], outputs: ['color'], csMain: ''});
  pass.reserveCapacity(); pass.setSize(64, 32); const buffer = pass.getOutput('color');
  pass.setSize(32, 16); expect(pass.getOutput('color')).toBe(buffer);
  pass.setSize(64, 32); expect(pass.getOutput('color')).toBe(buffer); expect(calls.createBuffer).toHaveBeenCalledOnce(); pass.dispose();
});
it('owns shared passes once and defers their final release', () => {
  let release!: () => void; const pool = new ScratchPool(work => {release = work;});
  const resource = {dispose: vi.fn(), reserveCapacity: vi.fn(), getMemoryBytes: () => 100}; const create = vi.fn(() => resource);
  expect(pool.get('copy', create)).toBe(pool.get('copy', create)); expect(create).toHaveBeenCalledOnce();
  expect(pool.getMemoryBytes()).toBe(100); pool.dispose(); expect(resource.dispose).not.toHaveBeenCalled(); release(); expect(resource.dispose).toHaveBeenCalledOnce();
});
