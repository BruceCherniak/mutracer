import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkyData } from '../src/engine/sky';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
});
import { ViewerEngine } from '../src/engine/ViewerEngine';

function fixture() {
  let finish!: (data: SkyData) => void;
  const viewer = Object.assign(Object.create(ViewerEngine.prototype), {
    disposed: false, skyFrame: 0, skyPending: false,
    settings: { envId: 'sky', skyTime: 14 },
    sky: { hours: 15, data: pixels(15) },
    skyWorker: { bake: vi.fn(() => new Promise<SkyData>(resolve => { finish = resolve; })) },
    cancelEnvironmentDownload: vi.fn(), setEnvironmentData: vi.fn()
  });
  return { viewer, finish: async (hours: number) => { finish(pixels(hours)); await vi.advanceTimersByTimeAsync(0); } };
}
function pixels(hours: number): SkyData {
  return { data: new Float32Array([hours, hours, hours, 1]), width: 1, height: 1 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => { void callback(0); }, 16));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('sky time updates', () => {
  it('coalesces edits during a bake and applies only the latest time', async () => {
    const { viewer, finish } = fixture();
    viewer.applySky('sky');
    await vi.advanceTimersByTimeAsync(16);
    expect(viewer.skyWorker.bake).toHaveBeenCalledWith(14);
    for (const hours of [13, 12]) { viewer.settings.skyTime = hours; viewer.applySky('sky'); }
    expect(viewer.skyWorker.bake).toHaveBeenCalledTimes(1);
    await finish(14);
    expect(viewer.setEnvironmentData).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(viewer.skyWorker.bake.mock.calls).toEqual([[14], [12]]);
    await finish(12);
    expect(viewer.setEnvironmentData).toHaveBeenCalledOnce();
    expect(viewer.setEnvironmentData).toHaveBeenCalledWith(pixels(12), 'sky');
    expect(viewer.skyPending).toBe(false);
  });

  it('does not replace an HDRI selected during a bake', async () => {
    const { viewer, finish } = fixture();
    viewer.applySky('sky');
    expect(viewer.cancelEnvironmentDownload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(16);
    viewer.settings.envId = 'studio';
    await finish(14);
    await vi.advanceTimersByTimeAsync(32);
    expect(viewer.setEnvironmentData).not.toHaveBeenCalled();
    expect(viewer.skyWorker.bake).toHaveBeenCalledTimes(1);
    expect(viewer.skyPending).toBe(false);
  });

  it.each(['selection', 'disposal'])('skips a queued bake after %s changes', async reason => {
    const { viewer } = fixture();
    viewer.applySky('sky');
    if (reason === 'selection') viewer.settings.envId = 'custom';
    else viewer.disposed = true;
    await vi.advanceTimersByTimeAsync(16);
    expect(viewer.skyWorker.bake).not.toHaveBeenCalled();
  });

  it('ignores a result arriving after disposal', async () => {
    const { viewer, finish } = fixture();
    viewer.applySky('sky');
    await vi.advanceTimersByTimeAsync(16);
    viewer.disposed = true;
    await finish(14);
    expect(viewer.setEnvironmentData).not.toHaveBeenCalled();
    expect(viewer.skyPending).toBe(false);
  });
});
