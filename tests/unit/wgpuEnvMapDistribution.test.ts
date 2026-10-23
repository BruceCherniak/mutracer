import { afterEach, describe, expect, it, vi } from 'vitest';
import { WGPUEnvMapDistribution } from '../../src/renderer/WGPUEnvMapDistribution';

function fixture() {
  vi.stubGlobal('GPUShaderStage', { COMPUTE: 4 });
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 128 });
  const buffers: Array<{ size: number; destroy: ReturnType<typeof vi.fn> }> = [];
  const device = {
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createComputePipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => { const buffer = { size, destroy: vi.fn() }; buffers.push(buffer); return buffer; },
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }), finish: () => ({})
    }),
    queue: { submit: vi.fn() }
  } as unknown as GPUDevice;
  const texture = (width: number, height: number) => ({ width, height, createView: () => ({}) }) as GPUTexture;
  return { device, buffers, texture };
}
afterEach(() => vi.unstubAllGlobals());

describe('WebGPU environment distribution resources', () => {
  it('reuses scan buffers across edits and releases them on resize and disposal', () => {
    const { device, buffers, texture } = fixture();
    const builder = new WGPUEnvMapDistribution(device);
    builder.build(texture(2048, 1024), texture(2050, 1025));
    const first = [...buffers];
    builder.build(texture(2048, 1024), texture(2050, 1025));
    expect(buffers).toHaveLength(2);
    first.forEach(buffer => expect(buffer.destroy).not.toHaveBeenCalled());
    builder.build(texture(1024, 512), texture(1026, 513));
    expect(buffers).toHaveLength(4);
    first.forEach(buffer => expect(buffer.destroy).toHaveBeenCalledOnce());
    builder.dispose();
    buffers.forEach(buffer => expect(buffer.destroy).toHaveBeenCalledOnce());
    expect(device.queue.submit).toHaveBeenCalledTimes(3);
  });

  it('declines maps that exceed either storage binding or allocation limits', () => {
    const supported = (storage: number, allocation: number) => WGPUEnvMapDistribution.supported({
      limits: { maxStorageBufferBindingSize: storage, maxBufferSize: allocation }
    } as GPUDevice, 2048, 1024);
    const bytes = 2048 * 1024 * 8;
    expect(supported(bytes, bytes)).toBe(true);
    expect(supported(bytes - 1, bytes)).toBe(false);
    expect(supported(bytes, bytes - 1)).toBe(false);
  });
});
