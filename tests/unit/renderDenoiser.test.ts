import { afterEach, describe, expect, it, vi } from 'vitest';
const { initializeOIDN } = vi.hoisted(() => ({initializeOIDN: vi.fn()}));
vi.mock('../../src/oidn', () => ({initializeOIDN}));
import Render from '../../src/Render';
import { renderFixture } from '../helpers/renderPipeline';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function filter() { return {tileExecute: vi.fn(), dispose: vi.fn(), prepareForImage: vi.fn(async () => {})}; }
afterEach(() => { initializeOIDN.mockReset(); vi.restoreAllMocks(); });

describe('per-render denoising', () => {
  it('shares identical networks, preserving the other render when one replaces its filter', async () => {
    const {engine} = renderFixture(); const standard = filter(), small = filter();
    initializeOIDN.mockResolvedValueOnce(standard).mockResolvedValueOnce(small);
    const a = new Render(engine, {denoiser: {type: 'oidn'}}), b = new Render(engine, {denoiser: {type: 'oidn', model: 'standard'}});
    await vi.waitFor(() => expect(standard.prepareForImage).toHaveBeenCalledTimes(2)); expect(initializeOIDN).toHaveBeenCalledOnce();
    a.denoiser = {type: 'oidn', model: 'small'}; await vi.waitFor(() => expect(small.prepareForImage).toHaveBeenCalledOnce());
    expect(standard.dispose).not.toHaveBeenCalled(); expect(initializeOIDN).toHaveBeenCalledTimes(2);
    b.dispose(); expect(standard.dispose).toHaveBeenCalledOnce(); a.dispose(); expect(small.dispose).toHaveBeenCalledOnce(); engine.dispose();
  });
  it('drops replaced pending prewarm failures and still reports current failures', async () => {
    const {engine} = renderFixture(); let reject!: (error: Error) => void;
    const prewarm = new Promise<void>((_, fail) => {reject = fail;});
    const old = {...filter(), prepareForImage: vi.fn(() => prewarm)}; const next = filter();
    initializeOIDN.mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    const error = vi.fn(); engine.on('error', error); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const render = new Render(engine, {denoiser: {type: 'oidn'}}); await settle(); expect(old.prepareForImage).toHaveBeenCalledOnce();
      render.denoiser = {type: 'oidn', model: 'small'}; await settle(); expect(old.dispose).toHaveBeenCalledOnce();
      reject(new Error('Native OIDN executor is disposed')); await settle(); expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
      const failure = new Error('Current prewarm failed'); next.prepareForImage.mockRejectedValue(failure);
      render.denoiser = null; render.denoiser = {type: 'oidn', model: 'small'}; initializeOIDN.mockResolvedValue(next); await settle();
      expect(error).toHaveBeenCalledWith(failure);
    } finally { engine.dispose(); log.mockRestore(); }
  });
  it('drops a superseded load and releases its engine lease', async () => {
    const {engine} = renderFixture(); const obsolete = filter(); let resolve!: (value: unknown) => void;
    initializeOIDN.mockImplementation(() => new Promise(done => {resolve = done;}));
    const render = new Render(engine, {denoiser: {type: 'oidn'}}); await settle(); render.denoiser = null;
    resolve(obsolete); await settle(); expect(obsolete.dispose).toHaveBeenCalledOnce(); expect(obsolete.prepareForImage).not.toHaveBeenCalled(); engine.dispose();
  });
  it.each(['converged', 'progressive', 'every-sample'] as const)('schedules %s on each independent target', async schedule => {
    const {engine, targets} = renderFixture(); const render = new Render(engine, {maxSamples: 8, denoiser: {type: 'jnlm', schedule}});
    for (let i = 0; i < 8; i++) {render.refine(); await settle();}
    expect(render.samples).toBe(8);
    expect(targets[0].performOIDNDenoise).toHaveBeenCalledTimes(schedule === 'converged' ? 1 : schedule === 'progressive' ? 3 : 8); engine.dispose();
  });
  it('serializes inference and discards queued jobs invalidated by engine input changes', async () => {
    const {engine, targets, camera} = renderFixture(); const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}}), b = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
    a.refine(); let done!: (value: boolean) => void;
    vi.mocked(targets[0].performOIDNDenoise!).mockImplementation(() => new Promise(resolve => {done = resolve;}));
    await settle(); b.refine(); await settle(); expect(targets[1].performOIDNDenoise).not.toHaveBeenCalled();
    camera.position = [1, 0, 0]; engine.update(); done(true); await settle();
    expect(targets[1].performOIDNDenoise).not.toHaveBeenCalled(); engine.dispose();
  });
  it('fails soft for OIDN on WebGL', async () => {
    const {engine} = renderFixture({backend: 'webgl'}); const error = vi.fn(); engine.on('error', error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'oidn'}}); await settle(); expect(render.refine()).toBe('finished'); expect(error).not.toHaveBeenCalled(); expect(initializeOIDN).not.toHaveBeenCalled(); expect(warn).toHaveBeenCalledOnce();}
    finally {engine.dispose(); warn.mockRestore();}
  });
});

it('composes an invisible render with current display settings before convergence denoising', async () => {
  const {engine, targets} = renderFixture(); engine.display.toneMappingExposure = 2;
  const render = new Render(engine, {width: 256, height: 256, denoiser: {type: 'jnlm'}});
  await render.converge({samples: 2});
  expect(targets[0].setToneMappingParams).toHaveBeenCalledWith(expect.objectContaining({exposure: 2}));
  expect(vi.mocked(targets[0].setToneMappingParams).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(targets[0].performOIDNDenoise!).mock.invocationCallOrder[0]);
  expect(targets[0].present).not.toHaveBeenCalled(); engine.dispose();
});
it('invalidates a completed filter when disabled without discarding samples', async () => {
  const {engine, targets} = renderFixture(); const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
  render.refine(); await settle(); vi.mocked(targets[0].invalidateDenoisedOutput).mockClear();
  render.denoiser = null; render.refine();
  expect(render.samples).toBe(1); expect(targets[0].invalidateDenoisedOutput).toHaveBeenCalledOnce(); engine.dispose();
});
it('denoises again after display settings change without tracing another sample', async () => {
  const {engine, targets} = renderFixture(); const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
  render.refine(); await settle(); engine.display.present(render);
  engine.display.shadowCatcherAlpha = .5; engine.display.present(render); render.refine(); await settle();
  expect(render.samples).toBe(1); expect(targets[0].trace).toHaveBeenCalledOnce();
  expect(targets[0].performOIDNDenoise).toHaveBeenCalledTimes(2); engine.dispose();
});

it('recomposes the requested render after waiting for the shared inference lease', async () => {
  const {engine, targets} = renderFixture(); let composed = ''; const filtered: string[] = [];
  const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}}), b = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
  a.refine(); b.refine();
  for (const target of targets) {
    vi.mocked(target.drawPostProcess).mockImplementation(() => {composed = target.label;});
    vi.mocked(target.performOIDNDenoise!).mockImplementation(async () => {filtered.push(composed); return true;});
  }
  await settle(); expect(filtered).toEqual(targets.map(target => target.label)); engine.dispose();
});

it('waits for active shared inference before prewarming the same network for another size', async () => {
  const {engine, targets} = renderFixture(); const network = filter(); initializeOIDN.mockResolvedValue(network);
  const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'oidn'}}); await settle(); a.refine();
  let done!: (value: boolean) => void; vi.mocked(targets[0].performOIDNDenoise!).mockImplementation(() => new Promise(resolve => {done = resolve;}));
  await settle(); const warmCalls = network.prepareForImage.mock.calls.length;
  const b = new Render(engine, {width: 256, height: 256, denoiser: {type: 'oidn'}}); await settle();
  expect(network.prepareForImage).toHaveBeenCalledTimes(warmCalls);
  done(true); await settle(); expect(network.prepareForImage).toHaveBeenCalledTimes(warmCalls + 1); b.dispose(); engine.dispose();
});


describe('progressive denoiser schedule', () => {
  function setup(denoiseMs = 0, maxSamples = 10000) {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const {engine, targets} = renderFixture();
    const render = new Render(engine, {maxSamples, denoiser: {type: 'jnlm', schedule: 'progressive'}});
    render.refine();
    const target = targets[0], trace = vi.mocked(target.trace).getMockImplementation()!;
    vi.mocked(target.trace).mockImplementation((camera, cap) => { clock += 10; return trace(camera, cap); });
    let finish!: (complete: boolean) => void;
    vi.mocked(target.performOIDNDenoise!).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    async function nextUpdate() {
      const calls = vi.mocked(target.performOIDNDenoise!).mock.calls.length;
      for (let frames = 0; frames < 20000; frames++) {
        render.refine(); await Promise.resolve();
        if (vi.mocked(target.performOIDNDenoise!).mock.calls.length > calls) {
          const count = render.samples;
          // Pending inference holds the sample target even if inference takes many frames.
          clock += denoiseMs; render.refine(); expect(render.samples).toBe(count);
          finish(true); await settle(); return count;
        }
      }
      throw new Error('Denoiser update did not start');
    }
    return {engine, render, nextUpdate};
  }
  it.each([0, 2000])('doubles from sample four without skipping updates with %i ms inference', async duration => {
    const {engine, nextUpdate} = setup(duration);
    const updates = [];
    for (let i = 0; i < 7; i++) updates.push(await nextUpdate());
    expect(updates).toEqual([1, 4, 8, 16, 32, 64, 128]); engine.dispose();
  });
  it('updates at least every ten seconds', async () => {
    const {engine, nextUpdate} = setup(); const updates = [];
    for (let i = 0; i < 12; i++) updates.push(await nextUpdate());
    expect(updates.slice(-4)).toEqual([512, 1024, 2025, 3026]); engine.dispose();
  });
  it('denoises the final sample count between doubling thresholds', async () => {
    const {engine, render, nextUpdate} = setup(0, 20); const updates = [];
    for (let i = 0; i < 5; i++) updates.push(await nextUpdate());
    expect(updates).toEqual([1, 4, 8, 16, 20]); expect(render.status).toBe('finished'); engine.dispose();
  });
  it.each([undefined, 'every-sample'] as const)('uses the default converged or explicit every-sample schedule: %s', async schedule => {
    const {engine, targets} = renderFixture();
    const render = new Render(engine, {maxSamples: 4, denoiser: {type: 'jnlm', schedule}});
    const filtered: number[] = [];
    render.refine();
    vi.mocked(targets[0].performOIDNDenoise!).mockImplementation(async () => {filtered.push(render.samples); return true;});
    await settle();
    for (let i = 0; i < 3; i++) {render.refine(); await settle();}
    expect(filtered).toEqual(schedule === 'every-sample' ? [1, 2, 3, 4] : [4]);
    expect(render.status).toBe('finished'); engine.dispose();
  });
});
