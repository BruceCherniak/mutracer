import { afterEach, describe, expect, it, vi } from 'vitest';
const { loadOIDNNetwork } = vi.hoisted(() => ({loadOIDNNetwork: vi.fn()}));
vi.mock('../../src/renderer/oidnNetwork', () => ({loadOIDNNetwork}));
import Render from '../../src/Render';
import { renderFixture } from '../helpers/renderPipeline';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function filter() { return {tileExecute: vi.fn(), dispose: vi.fn(), prepareForImage: vi.fn(async () => {})}; }
afterEach(() => { loadOIDNNetwork.mockReset(); vi.restoreAllMocks(); });

describe('per-render denoising', () => {
  it('shares identical networks, preserving the other render when one replaces its filter', async () => {
    const {engine} = renderFixture(); const standard = filter(), small = filter();
    loadOIDNNetwork.mockResolvedValueOnce(standard).mockResolvedValueOnce(small);
    const a = new Render(engine, {denoiser: {type: 'oidn'}}), b = new Render(engine, {denoiser: {type: 'oidn', model: 'standard'}});
    await vi.waitFor(() => expect(standard.prepareForImage).toHaveBeenCalledTimes(2)); expect(loadOIDNNetwork).toHaveBeenCalledOnce();
    a.setDenoiser({type: 'oidn', model: 'small'}); await vi.waitFor(() => expect(small.prepareForImage).toHaveBeenCalledOnce());
    expect(standard.dispose).not.toHaveBeenCalled(); expect(loadOIDNNetwork).toHaveBeenCalledTimes(2);
    b.dispose(); expect(standard.dispose).toHaveBeenCalledOnce(); a.dispose(); expect(small.dispose).toHaveBeenCalledOnce(); engine.dispose();
  });
  it('drops replaced pending prewarm failures and still reports current failures', async () => {
    const {engine} = renderFixture(); let reject!: (error: Error) => void;
    const prewarm = new Promise<void>((_, fail) => {reject = fail;});
    const old = {...filter(), prepareForImage: vi.fn(() => prewarm)}; const next = filter();
    loadOIDNNetwork.mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    const error = vi.fn(); engine.on('error', error); const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const render = new Render(engine, {denoiser: {type: 'oidn'}}); await settle(); expect(old.prepareForImage).toHaveBeenCalledOnce();
      render.setDenoiser({type: 'oidn', model: 'small'}); await settle(); expect(old.dispose).toHaveBeenCalledOnce();
      reject(new Error('Native OIDN executor is disposed')); await settle(); expect(error).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
      const failure = new Error('Current prewarm failed'); next.prepareForImage.mockRejectedValue(failure);
      render.setDenoiser(null); render.setDenoiser({type: 'oidn', model: 'small'}); loadOIDNNetwork.mockResolvedValue(next); await settle();
      expect(error).toHaveBeenCalledWith(failure);
    } finally { engine.dispose(); log.mockRestore(); }
  });
  it('drops a superseded load and releases its engine lease', async () => {
    const {engine} = renderFixture(); const obsolete = filter(); let resolve!: (value: unknown) => void;
    loadOIDNNetwork.mockImplementation(() => new Promise(done => {resolve = done;}));
    const render = new Render(engine, {denoiser: {type: 'oidn'}}); await settle(); render.setDenoiser(null);
    resolve(obsolete); await settle(); expect(obsolete.dispose).toHaveBeenCalledOnce(); expect(obsolete.prepareForImage).not.toHaveBeenCalled(); engine.dispose();
  });
  it.each(['converged', 'progressive', 'every-sample'] as const)('schedules %s on each independent target', async schedule => {
    const {engine, targets} = renderFixture(); const render = new Render(engine, {maxSamples: 8, denoiser: {type: 'jnlm', schedule}});
    for (let i = 0; i < 8; i++) {render.refine(); await settle();}
    expect(render.samples).toBe(8);
    expect(targets[0].performDenoise).toHaveBeenCalledTimes(schedule === 'converged' ? 1 : schedule === 'progressive' ? 3 : 8); engine.dispose();
  });
  it('serializes inference and discards queued jobs invalidated by engine input changes', async () => {
    const {engine, targets, camera} = renderFixture(); const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}}), b = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
    a.refine(); let done!: (value: boolean) => void;
    vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {done = resolve;}));
    await settle(); b.refine(); await settle(); expect(targets[1].performDenoise).not.toHaveBeenCalled();
    camera.position = [1, 0, 0]; engine.update(); done(true); await settle();
    expect(targets[1].performDenoise).not.toHaveBeenCalled(); engine.dispose();
  });
  it('fails soft for OIDN on WebGL', async () => {
    const {engine} = renderFixture({backend: 'webgl'}); const error = vi.fn(); engine.on('error', error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'oidn'}}); await settle(); expect(render.refine()).toBe('finished'); expect(error).not.toHaveBeenCalled(); expect(loadOIDNNetwork).not.toHaveBeenCalled(); expect(warn).toHaveBeenCalledOnce();}
    finally {engine.dispose(); warn.mockRestore();}
  });
});

it('composes an invisible render with current display settings before convergence denoising', async () => {
  const {engine, targets} = renderFixture(); engine.display.toneMappingExposure = 2;
  const render = new Render(engine, {width: 256, height: 256, denoiser: {type: 'jnlm'}});
  await render.converge({samples: 2});
  expect(targets[0].setToneMappingParams).toHaveBeenCalledWith(expect.objectContaining({exposure: 2}));
  expect(vi.mocked(targets[0].setToneMappingParams).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(targets[0].performDenoise!).mock.invocationCallOrder[0]);
  expect(targets[0].present).not.toHaveBeenCalled(); engine.dispose();
});
it('invalidates a completed filter when disabled without discarding samples', async () => {
  const {engine, targets} = renderFixture(); const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
  render.refine(); await settle(); vi.mocked(targets[0].invalidateDenoisedOutput).mockClear();
  render.setDenoiser(null); render.refine();
  expect(render.samples).toBe(1); expect(targets[0].invalidateDenoisedOutput).toHaveBeenCalledOnce(); engine.dispose();
});
it('denoises again after display settings change without tracing another sample', async () => {
  const {engine, targets} = renderFixture(); const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
  render.refine(); await settle(); engine.display.present(render);
  engine.display.shadowCatcherAlpha = .5; engine.display.present(render); render.refine(); await settle();
  expect(render.samples).toBe(1); expect(targets[0].trace).toHaveBeenCalledOnce();
  expect(targets[0].performDenoise).toHaveBeenCalledTimes(2); engine.dispose();
});

it.each(['exposure', 'tone mapping', 'HDR'] as const)('cancels the first OIDN inference before applying changed %s settings', async setting => {
  const {engine, targets} = renderFixture();
  loadOIDNNetwork.mockResolvedValue(filter());
  const render = new Render(engine, {maxSamples: 1});
  await render.setDenoiser({type: 'oidn'});
  render.refine();
  const target = targets[0];
  let finish!: (complete: boolean) => void;
  let signal!: AbortSignal;
  vi.mocked(target.performDenoise!).mockImplementation((_filter, _alpha, _schedule, inputSignal) => {
    signal = inputSignal!;
    return new Promise(resolve => {finish = resolve;});
  });
  await settle();
  expect(render.denoising).toBe(true);
  expect(signal.aborted).toBe(false);
  vi.mocked(target.cancelDenoise!).mockClear();
  if (setting === 'exposure') engine.display.toneMappingExposure = 2;
  else if (setting === 'tone mapping') engine.display.toneMapping = 'aces';
  else engine.display.hdrOutputEnabled = true;
  engine.display.present(render);
  expect(signal.aborted).toBe(true);
  expect(target.cancelDenoise).toHaveBeenCalled();
  const cancelOrder = vi.mocked(target.cancelDenoise!).mock.invocationCallOrder[0];
  expect(cancelOrder).toBeLessThan(vi.mocked(target.setToneMappingParams).mock.invocationCallOrder.at(-1)!);
  expect(cancelOrder).toBeLessThan(vi.mocked(target.drawPostProcess).mock.invocationCallOrder.at(-1)!);
  const composed = vi.mocked(target.drawPostProcess).mock.calls.length;
  finish(true); await settle();
  expect(target.drawPostProcess).toHaveBeenCalledTimes(composed);
  vi.mocked(target.performDenoise!).mockResolvedValue(true);
  render.refine(); await settle();
  expect(target.performDenoise).toHaveBeenCalledTimes(2);
  expect(target.trace).toHaveBeenCalledOnce();
  engine.dispose();
});

it('recomposes the requested render after waiting for the shared inference lease', async () => {
  const {engine, targets} = renderFixture(); let composed = ''; const filtered: string[] = [];
  const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}}), b = new Render(engine, {maxSamples: 1, denoiser: {type: 'jnlm'}});
  a.refine(); b.refine();
  for (const target of targets) {
    vi.mocked(target.drawPostProcess).mockImplementation(() => {composed = target.label;});
    vi.mocked(target.performDenoise!).mockImplementation(async () => {filtered.push(composed); return true;});
  }
  await settle(); expect(filtered).toEqual(targets.map(target => target.label)); engine.dispose();
});

it('waits for active shared inference before prewarming the same network for another size', async () => {
  const {engine, targets} = renderFixture(); const network = filter(); loadOIDNNetwork.mockResolvedValue(network);
  const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'oidn'}}); await settle(); a.refine();
  let done!: (value: boolean) => void; vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {done = resolve;}));
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
    vi.mocked(target.performDenoise!).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    async function nextUpdate() {
      const calls = vi.mocked(target.performDenoise!).mock.calls.length;
      for (let frames = 0; frames < 20000; frames++) {
        render.refine(); await Promise.resolve();
        if (vi.mocked(target.performDenoise!).mock.calls.length > calls) {
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
    vi.mocked(targets[0].performDenoise!).mockImplementation(async () => {filtered.push(render.samples); return true;});
    await settle();
    for (let i = 0; i < 3; i++) {render.refine(); await settle();}
    expect(filtered).toEqual(schedule === 'every-sample' ? [1, 2, 3, 4] : [4]);
    expect(render.status).toBe('finished'); engine.dispose();
  });
});

it('keeps equal OIDN assignments and schedule edits on the current in-flight inference', async () => {
  const {engine, targets} = renderFixture(); const network = filter(); loadOIDNNetwork.mockResolvedValue(network);
  const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'oidn'}}); await settle();
  render.refine(); let finish!: (value: boolean) => void;
  vi.mocked(targets[0].performDenoise!).mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  await settle(); vi.mocked(targets[0].cancelDenoise!).mockClear(); vi.mocked(targets[0].invalidateDenoisedOutput).mockClear();
  const configuration = render.denoiser;
  render.setDenoiser({type: 'oidn'}); expect(render.denoiser).toBe(configuration);
  render.setDenoiser({type: 'oidn', model: 'standard', schedule: 'progressive'});
  expect(render.denoising).toBe(true); expect(loadOIDNNetwork).toHaveBeenCalledOnce();
  expect(targets[0].cancelDenoise).not.toHaveBeenCalled(); expect(targets[0].invalidateDenoisedOutput).not.toHaveBeenCalled();
  finish(true); await settle(); expect(render.status).toBe('finished'); engine.dispose();
});

it.each([
  {}, {type: 'missing'}, {type: 'oidn', strength: 1}, {type: 'jnlm', model: 'small'},
  {type: 'jnlm', strength: 0}, {type: 'jnlm', searchRadius: 17}, {type: 'jnlm', patchRadius: -1},
  {type: 'jnlm', iterations: 5}, {type: 'jnlm', albedoBandwidth: NaN},
  {type: 'jnlm', normalBandwidth: 11}, {type: 'oidn', schedule: 'unknown'}
])('rejects %j before changing a completed filter and output', async invalid => {
  const {engine, targets} = renderFixture(); const network = filter(); loadOIDNNetwork.mockResolvedValue(network);
  const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'oidn'}}); await settle();
  render.refine(); await settle(); const configuration = render.denoiser;
  vi.mocked(targets[0].cancelDenoise!).mockClear(); vi.mocked(targets[0].invalidateDenoisedOutput).mockClear();
  expect(() => {render.setDenoiser(invalid as unknown as import('../../src/main').DenoiserOptions);}).toThrow();
  expect(render.denoiser).toBe(configuration); expect(network.dispose).not.toHaveBeenCalled();
  expect(targets[0].cancelDenoise).not.toHaveBeenCalled(); expect(targets[0].invalidateDenoisedOutput).not.toHaveBeenCalled();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); await render.readPixels('denoised'); expect(warn).not.toHaveBeenCalled();
  engine.dispose();
});

it('returns a frozen snapshot independent of the assigned object', () => {
  const {engine} = renderFixture(); const options = {type: 'jnlm' as const, strength: 2};
  const render = new Render(engine, {denoiser: options}); options.strength = 3;
  expect(render.denoiser).toEqual({type: 'jnlm', strength: 2}); expect(Object.isFrozen(render.denoiser)).toBe(true);
  expect(() => Object.assign(render.denoiser!, {strength: 4})).toThrow(); engine.dispose();
});

describe('setDenoiser readiness', () => {
  it('resolves after OIDN loads and returns the same promise for an equal configuration', async () => {
    const {engine} = renderFixture(); let resolve!: (value: unknown) => void;
    loadOIDNNetwork.mockImplementation(() => new Promise(done => {resolve = done;}));
    const render = new Render(engine); const ready = render.setDenoiser({type: 'oidn'}); let done = false; void ready.then(() => {done = true;});
    expect(render.setDenoiser({type: 'oidn', model: 'standard'})).toBe(ready);
    await settle(); expect(done).toBe(false);
    resolve(filter()); await ready; expect(loadOIDNNetwork).toHaveBeenCalledOnce(); engine.dispose();
  });
  it('rejects with the current load failure instead of reporting an engine error, and retries after disabling', async () => {
    const {engine} = renderFixture(); const failure = new Error('Weights missing'); const error = vi.fn(); engine.on('error', error);
    loadOIDNNetwork.mockRejectedValueOnce(failure).mockResolvedValueOnce(filter());
    const render = new Render(engine);
    await expect(render.setDenoiser({type: 'oidn'})).rejects.toBe(failure); expect(error).not.toHaveBeenCalled();
    await render.setDenoiser(null); await render.setDenoiser({type: 'oidn'}); expect(loadOIDNNetwork).toHaveBeenCalledTimes(2); engine.dispose();
  });
  it('resolves a superseded load without its failure', async () => {
    const {engine} = renderFixture(); let reject!: (error: Error) => void;
    loadOIDNNetwork.mockImplementation(() => new Promise((_, fail) => {reject = fail;}));
    const render = new Render(engine); const ready = render.setDenoiser({type: 'oidn'}); await settle();
    await render.setDenoiser({type: 'jnlm'}); reject(new Error('obsolete')); await expect(ready).resolves.toBeUndefined(); engine.dispose();
  });
  it('reports a constructor option load failure through engine errors', async () => {
    const {engine} = renderFixture(); const failure = new Error('Weights missing'); const error = vi.fn(); engine.on('error', error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadOIDNNetwork.mockRejectedValue(failure); new Render(engine, {denoiser: {type: 'oidn'}});
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(failure)); engine.dispose(); log.mockRestore();
  });
});

it('loads an explicit network through the render and shares it across download signals', async () => {
  const {engine} = renderFixture(); const network = filter(); loadOIDNNetwork.mockResolvedValue(network);
  const a = new Render(engine, {denoiser: {type: 'oidn', weightsUrl: '/custom.tza', signal: new AbortController().signal}});
  const b = new Render(engine, {denoiser: {type: 'oidn', weightsUrl: '/custom.tza', signal: new AbortController().signal}});
  await settle(); expect(loadOIDNNetwork).toHaveBeenCalledOnce();
  expect(loadOIDNNetwork).toHaveBeenCalledWith(engine, expect.objectContaining({weightsUrl: '/custom.tza'}));
  a.dispose(); expect(network.dispose).not.toHaveBeenCalled(); b.dispose(); expect(network.dispose).toHaveBeenCalledOnce(); engine.dispose();
});

it.each([
  {type: 'oidn', weightsUrl: '/custom.tza', model: 'standard'},
  {type: 'oidn', weightsUrl: '/custom.tza', weightsBaseUrl: '/weights/'},
  {type: 'oidn', aux: false}, {type: 'oidn', hdrTransfer: 'log'},
  {type: 'oidn', engine: 'bad'}, {type: 'oidn', dynamicTile: {bad: 1}}
])('rejects incompatible OIDN options %j synchronously', options => {
  const {engine} = renderFixture(); const render = new Render(engine, {denoiser: {type: 'jnlm'}}); const before = render.denoiser;
  expect(() => {render.setDenoiser(options as unknown as import('../../src/main').DenoiserOptions);}).toThrow();
  expect(render.denoiser).toBe(before); expect(loadOIDNNetwork).not.toHaveBeenCalled(); engine.dispose();
});

it.each([
  {engine: 'wgsl'}, {precision: 'fp32'}, {dynamicTile: false}, {maxTileSize: 1024},
  {aux: false}, {hdr: false}, {hdrTransfer: 'log'}, {auxiliaryModelUrls: {albedo: '/a.tza', normal: '/n.tza'}}
] as const)('keys the network by implementation option %j', async change => {
  const {engine} = renderFixture(); loadOIDNNetwork.mockImplementation(async () => filter());
  new Render(engine, {denoiser: {type: 'oidn', weightsUrl: '/custom.tza'}});
  new Render(engine, {denoiser: {type: 'oidn', weightsUrl: '/custom.tza', ...change}});
  await settle(); expect(loadOIDNNetwork).toHaveBeenCalledTimes(2); engine.dispose();
});

it('snapshots mutable URL and nested options and normalizes property order/defaults', async () => {
  const {engine} = renderFixture(); const network = filter(); loadOIDNNetwork.mockResolvedValue(network);
  const url = new URL('https://example.com/model.tza'), tile = {initialTileSize: 432}, urls = {albedo: new URL('https://example.com/a.tza'), normal: '/n.tza'};
  const a = new Render(engine, {denoiser: {type: 'oidn', weightsUrl: url, dynamicTile: tile, auxiliaryModelUrls: urls}});
  url.pathname = '/changed'; tile.initialTileSize = 999; urls.albedo.pathname = '/changed';
  const b = new Render(engine, {denoiser: {type: 'oidn', weightsUrl: 'https://example.com/model.tza', precision: 'auto', auxiliaryModelUrls: {normal: '/n.tza', albedo: 'https://example.com/a.tza'}, dynamicTile: {adjustmentStep: 16, initialTileSize: 432}}});
  await settle(); expect(loadOIDNNetwork).toHaveBeenCalledOnce();
  expect(a.denoiser).toEqual(expect.objectContaining({weightsUrl: 'https://example.com/model.tza', dynamicTile: {initialTileSize: 432}}));
  expect(Object.isFrozen((a.denoiser as import('../../src/main').OIDNDenoiserOptions).dynamicTile)).toBe(true);
  a.dispose(); b.dispose(); engine.dispose();
});
