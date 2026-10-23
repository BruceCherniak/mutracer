import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkyWorker, type SkyBakeResponse } from '../src/engine/skyWorker';

const sky = { data: new Float32Array([1, 2, 3, 1]), width: 1, height: 1 };
class FakeWorker {
  static instance: FakeWorker;
  onmessage?: (event: MessageEvent<SkyBakeResponse>) => void;
  onerror?: (event: ErrorEvent) => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instance = this; }
  reply(data: SkyBakeResponse) { this.onmessage?.({ data } as MessageEvent<SkyBakeResponse>); }
}

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('OffscreenCanvas', class {});
});
afterEach(() => vi.unstubAllGlobals());

describe('sky worker', () => {
  it('resolves transferred radiance without baking on the UI thread', async () => {
    const fallback = { bake: vi.fn(() => sky) };
    const worker = new SkyWorker(fallback);
    const result = worker.bake(12);
    expect(FakeWorker.instance.postMessage).toHaveBeenCalledWith(12);
    FakeWorker.instance.reply({ data: sky });
    expect(await result).toBe(sky);
    expect(fallback.bake).not.toHaveBeenCalled();
    worker.dispose();
    expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
  });

  it('uses the main-thread fallback when offscreen rendering is unavailable', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const fallback = { bake: vi.fn(() => sky) };
    expect(await new SkyWorker(fallback).bake(6)).toBe(sky);
    expect(fallback.bake).toHaveBeenCalledWith(6);
  });

  it.each(['message', 'event', 'creation'] as const)('recovers from a worker %s failure and disables further worker attempts', async (failure) => {
    if (failure === 'creation') vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
    const fallback = { bake: vi.fn(() => sky) };
    const worker = new SkyWorker(fallback);
    const first = worker.bake(7);
    if (failure === 'message') FakeWorker.instance.reply({ error: 'No worker WebGL context' });
    if (failure === 'event') FakeWorker.instance.onerror?.({ preventDefault: vi.fn(), message: 'Failed to load' } as unknown as ErrorEvent);
    expect(await first).toBe(sky);
    expect(await worker.bake(8)).toBe(sky);
    expect(fallback.bake.mock.calls).toEqual([[7], [8]]);
    if (failure !== 'creation') expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
    worker.dispose();
  });

  it('rejects a pending bake on disposal without starting the fallback', async () => {
    const fallback = { bake: vi.fn(() => sky) };
    const worker = new SkyWorker(fallback);
    const result = worker.bake(18);
    worker.dispose();
    await expect(result).rejects.toThrow('disposed');
    await expect(worker.bake(12)).rejects.toThrow('disposed');
    expect(fallback.bake).not.toHaveBeenCalled();
  });
});
