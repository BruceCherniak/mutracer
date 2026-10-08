import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WGPURayTraceOutputPass
} from '../../src/renderer/WGPURayTraceOutput';

describe('WGPURayTraceOutputPass resource lifetime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retires resized textures after submitted GPU work completes', async () => {
    vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2 });
    vi.stubGlobal('GPUTextureUsage', {
      RENDER_ATTACHMENT: 1,
      TEXTURE_BINDING: 2,
      COPY_SRC: 4
    });

    let finishSubmittedWork!: () => void;
    const submittedWorkDone = new Promise<void>((resolve) => {
      finishSubmittedWork = resolve;
    });
    const textures: Array<{
      descriptor: GPUTextureDescriptor;
      destroy: ReturnType<typeof vi.fn>;
    }> = [];
    const device = {
      createBuffer: vi.fn(() => ({})),
      createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
        const texture = { descriptor, destroy: vi.fn() };
        textures.push(texture);
        return texture;
      }),
      queue: {
        onSubmittedWorkDone: vi.fn(() => submittedWorkDone)
      }
    } as unknown as GPUDevice;
    const pass = new WGPURayTraceOutputPass(device);

    pass.setSize(1920, 1088);
    const oldTextures = textures.slice();
    pass.setSize(1280, 720);

    expect(oldTextures).toHaveLength(4);
    expect(device.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    oldTextures.forEach((texture) => {
      expect(texture.destroy).not.toHaveBeenCalled();
    });

    finishSubmittedWork();
    await submittedWorkDone;
    await new Promise((resolve) => setTimeout(resolve, 0));

    oldTextures.forEach((texture) => {
      expect(texture.destroy).toHaveBeenCalledOnce();
    });
  });

});
