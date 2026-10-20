import { describe, expect, it, vi } from 'vitest';
import { WGPUShaderCache, retainedShaderCapacity } from '../../src/renderer/WGPUShaderCache';

function fixture() {
  const device = {
    createShaderModule: vi.fn(() => ({})),
    createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})),
    createComputePipelineAsync: vi.fn(async () => ({}))
  };
  const cache = new WGPUShaderCache(device as unknown as GPUDevice);
  const descriptor = (code = 'fn main() {}'): GPUComputePipelineDescriptor => ({
    layout: cache.createPipelineLayout({
      bindGroupLayouts: [cache.createBindGroupLayout({ entries: [] })]
    }),
    compute: { module: cache.createShaderModule({ code }), entryPoint: 'main' }
  });
  return { device, cache, descriptor };
}

describe('WebGPU pipeline reuse', () => {
  it('reuses a retained pipeline after its shader module has been evicted', async () => {
    const {device, cache, descriptor} = fixture();
    const original = await cache.createComputePipelineAsync(descriptor());
    for (let i = 0; i < 9; i++) cache.createShaderModule({code: `fn other${i}() {}`});
    expect(await cache.createComputePipelineAsync(descriptor())).toBe(original);
    expect(device.createShaderModule).toHaveBeenCalledTimes(11);
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
  });
  it('reuses actual pipelines after an A/B/A scene variant switch', async () => {
    const { device, cache, descriptor } = fixture();
    const a = await cache.createComputePipelineAsync(descriptor());
    await cache.createComputePipelineAsync(descriptor('fn main() { var b = 1; }'));
    expect(await cache.createComputePipelineAsync(descriptor())).toBe(a);
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(2);
    expect(device.createShaderModule).toHaveBeenCalledTimes(2);
    expect(device.createPipelineLayout).toHaveBeenCalledTimes(1);
    expect(device.createBindGroupLayout).toHaveBeenCalledTimes(1);
  });

  it('deduplicates pending requests and ignores label/constant key order', async () => {
    const { device, cache, descriptor } = fixture();
    const d = descriptor();
    d.compute.constants = { FIRST: 1, SECOND: 2 };
    const a = cache.createComputePipelineAsync(d);
    const b = cache.createComputePipelineAsync({
      ...d, label: 'renamed', compute: { ...d.compute, constants: { SECOND: 2, FIRST: 1 } }
    });
    expect(b).toBe(a);
    await a;
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(1);
  });

  it('distinguishes source, layout, entry point and specialization values', async () => {
    const { device, cache, descriptor } = fixture();
    const d = descriptor();
    await cache.createComputePipelineAsync(d);
    await cache.createComputePipelineAsync({ ...d, layout: {} as GPUPipelineLayout });
    await cache.createComputePipelineAsync({ ...d, compute: { ...d.compute, entryPoint: 'other' } });
    await cache.createComputePipelineAsync({ ...d, compute: { ...d.compute, constants: { A: 1 } } });
    await cache.createComputePipelineAsync(descriptor('fn main() { var b = 2; }'));
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(5);
  });

  it('retries rejected compilations and releases entries on disposal', async () => {
    const { device, cache, descriptor } = fixture();
    device.createComputePipelineAsync.mockRejectedValueOnce(new Error('lost'));
    await expect(cache.createComputePipelineAsync(descriptor())).rejects.toThrow('lost');
    await cache.createComputePipelineAsync(descriptor());
    cache.clear();
    await cache.createComputePipelineAsync(descriptor());
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(3);
    expect(device.createShaderModule).toHaveBeenCalledTimes(2);
  });

  it('bounds retained source variants with LRU eviction', () => {
    const { cache, device } = fixture();
    const first = cache.createShaderModule({ code: '0' });
    for (let i = 1; i < 8; i++) cache.createShaderModule({ code: String(i) });
    expect(cache.createShaderModule({ code: '0' })).toBe(first);
    cache.createShaderModule({ code: '8' });
    expect(cache.createShaderModule({ code: '0' })).toBe(first);
    cache.createShaderModule({ code: '1' });
    expect(device.createShaderModule).toHaveBeenCalledTimes(10);
  });

  it('keeps stage stack capacity stable while always covering traversal needs', () => {
    let capacity = 0;
    expect([2, 4, 3, 7, 8].map((need) => {
      capacity = retainedShaderCapacity(need, capacity);
      return capacity;
    })).toEqual([8, 8, 8, 8, 8]);
    expect(retainedShaderCapacity(9, capacity)).toBe(16);
    expect(retainedShaderCapacity(1, 32)).toBe(32);
    expect(retainedShaderCapacity(51, 32)).toBe(64);
  });
});
