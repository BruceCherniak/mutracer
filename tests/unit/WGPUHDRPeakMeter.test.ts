import { describe, expect, it, vi } from 'vitest';
import { WGPUHDRPeakMeter } from '../../src/renderer/WGPUHDRPeakMeter';

describe('WGPUHDRPeakMeter', () => {
  it('reads the encoded frame peak and throttles GPU readback', async () => {
    vi.stubGlobal('GPUBufferUsage', {
      STORAGE: 1,
      COPY_SRC: 2,
      COPY_DST: 4,
      MAP_READ: 8
    });
    vi.stubGlobal('GPUMapMode', { READ: 1 });

    const mappedPeak = new Float32Array([2.5]).buffer;
    const buffers = Array.from({ length: 2 }, () => ({
      destroy: vi.fn(),
      mapAsync: vi.fn(async () => undefined),
      getMappedRange: vi.fn(() => mappedPeak),
      unmap: vi.fn(),
      mapState: 'mapped'
    }));
    let bufferIndex = 0;
    const dispatchWorkgroups = vi.fn();
    const encoder = {
      clearBuffer: vi.fn(),
      beginComputePass: vi.fn(() => ({
        setPipeline: vi.fn(),
        setBindGroup: vi.fn(),
        dispatchWorkgroups,
        end: vi.fn()
      })),
      copyBufferToBuffer: vi.fn()
    } as unknown as GPUCommandEncoder;
    const device = {
      createBuffer: vi.fn(() => buffers[bufferIndex++]),
      createShaderModule: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({
        getBindGroupLayout: vi.fn(() => ({}))
      })),
      createBindGroup: vi.fn(() => ({})),
      queue: {
        onSubmittedWorkDone: vi.fn(async () => undefined)
      }
    } as unknown as GPUDevice;
    const texture = {
      createView: vi.fn(() => ({}))
    } as unknown as GPUTexture;
    const meter = new WGPUHDRPeakMeter(device);

    expect(meter.encode(encoder, texture, 32, 17, 1000)).toBe(true);
    expect(dispatchWorkgroups).toHaveBeenCalledWith(2, 2);
    expect(meter.encode(encoder, texture, 32, 17, 1100)).toBe(false);

    await meter.resolve();

    expect(meter.getPeakDisplayValue()).toBe(2.5);
    expect(meter.encode(encoder, texture, 32, 17, 1600)).toBe(true);
  });
});
