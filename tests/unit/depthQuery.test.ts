import { afterEach, describe, expect, it, vi } from 'vitest';
import Renderer from '../../src/Renderer';
import type { RenderingPipeline } from '../../src/renderer/RenderingPipeline';
import { packDepthSampleArea, unpackDepthSamples } from '../../src/renderer/depthQuery';
import { readFloatPixelsAsync } from '../../src/renderer/WebGLReadback';

describe('GPU depth query contract', () => {
  it('maps top-left viewport coordinates to a square bottom-left UV area', () => {
    expect(Array.from(packDepthSampleArea({ x: 0.25, y: 0.75, size: 0.125 }, 2)))
      .toEqual([0.25, 0.25, 0.0625, 0.125]);
    expect(Array.from(packDepthSampleArea({ x: 1, y: 0, size: 0 }, 0.5)))
      .toEqual([1, 1, 0, 0]);
    expect(() => packDepthSampleArea({ x: NaN, y: 0.5, size: 0.1 }, 1)).toThrow(RangeError);
    expect(() => packDepthSampleArea({ x: 0.5, y: 0.5, size: -1 }, 1)).toThrow(RangeError);
  });

  it('copies only the depth component out of the compact GPU result', () => {
    const rgba = new Float32Array(49 * 4).fill(99);
    for (let i = 0; i < 49; i++) rgba[i * 4] = i;
    const samples = unpackDepthSamples(rgba);
    rgba.fill(0);
    expect(Array.from(samples)).toEqual(Array.from({ length: 49 }, (_, i) => i));
  });

  it('returns no result before preparation, limits concurrent reads and discards disposed results', async () => {
    const renderer = new Renderer({ canvas: {} as HTMLCanvasElement });
    const area = { x: 0.5, y: 0.5, size: 0.07 };
    expect(await renderer.readDepthSamples(area)).toBeUndefined();
    let resolve!: (samples: Float32Array) => void;
    const read = vi.fn(() => new Promise<Float32Array>(r => { resolve = r; }));
    const dispose = vi.fn();
    (renderer as unknown as { _pipeline: RenderingPipeline })._pipeline = {
      readDepthSamples: read, dispose
    } as unknown as RenderingPipeline;
    const first = renderer.readDepthSamples(area);
    expect(await renderer.readDepthSamples(area)).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
    resolve(new Float32Array(49).fill(3));
    expect(await first).toEqual(new Float32Array(49).fill(3));
    const second = renderer.readDepthSamples(area);
    renderer.dispose();
    resolve(new Float32Array(49).fill(4));
    expect(await second).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases the read guard after a GPU failure', async () => {
    const renderer = new Renderer({ canvas: {} as HTMLCanvasElement });
    const read = vi.fn().mockRejectedValueOnce(new Error('device lost'))
      .mockResolvedValueOnce(new Float32Array(49));
    (renderer as unknown as { _pipeline: RenderingPipeline })._pipeline = {
      readDepthSamples: read
    } as unknown as RenderingPipeline;
    const area = { x: 0.5, y: 0.5, size: 0.07 };
    await expect(renderer.readDepthSamples(area)).rejects.toThrow('device lost');
    expect(await renderer.readDepthSamples(area)).toHaveLength(49);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('WebGL asynchronous depth readback', () => {
  afterEach(() => { vi.useRealTimers(); });
  function context() {
    const gl = {
      PIXEL_PACK_BUFFER: 1, PIXEL_PACK_BUFFER_BINDING: 2, STREAM_READ: 3,
      RGBA: 4, FLOAT: 5, SYNC_GPU_COMMANDS_COMPLETE: 6,
      WAIT_FAILED: 7, ALREADY_SIGNALED: 8, CONDITION_SATISFIED: 9, TIMEOUT_EXPIRED: 10,
      createBuffer: vi.fn(() => ({})), getParameter: vi.fn(() => null),
      bindBuffer: vi.fn(), bufferData: vi.fn(), readPixels: vi.fn(),
      fenceSync: vi.fn(() => ({})), flush: vi.fn(),
      clientWaitSync: vi.fn(() => 8), isContextLost: vi.fn(() => false),
      getBufferSubData: vi.fn((_target: number, _offset: number, data: Float32Array) => data.fill(3)),
      deleteSync: vi.fn(), deleteBuffer: vi.fn()
    };
    return gl;
  }

  it('does not read CPU data until the fence signals, then releases the PBO', async () => {
    vi.useFakeTimers();
    const gl = context();
    gl.clientWaitSync.mockReturnValueOnce(gl.TIMEOUT_EXPIRED);
    const promise = readFloatPixelsAsync(gl as unknown as WebGL2RenderingContext, 7, 7, new AbortController().signal);
    expect(gl.readPixels).toHaveBeenCalledWith(0, 0, 7, 7, gl.RGBA, gl.FLOAT, 0);
    expect(gl.getBufferSubData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(gl.getBufferSubData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(await promise).toEqual(new Float32Array(196).fill(3));
    expect(gl.clientWaitSync).toHaveBeenCalledWith(expect.anything(), 0, 0);
    expect(gl.deleteSync).toHaveBeenCalledOnce();
    expect(gl.deleteBuffer).toHaveBeenCalledOnce();
  });

  it('cancels pending readbacks without reading or leaving a polling timer', async () => {
    vi.useFakeTimers();
    const gl = context();
    const controller = new AbortController();
    const promise = readFloatPixelsAsync(gl as unknown as WebGL2RenderingContext, 7, 7, controller.signal);
    const rejected = expect(promise).rejects.toThrow('cancelled');
    controller.abort();
    await rejected;
    expect(gl.getBufferSubData).not.toHaveBeenCalled();
    expect(gl.deleteSync).toHaveBeenCalledOnce();
    expect(gl.deleteBuffer).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
