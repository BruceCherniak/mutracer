import {afterEach, describe, expect, it, vi} from 'vitest';
import Render, {type DenoiseInput, type Denoiser} from '../../src/Render';
import type {DenoiserHandle} from '../../src/renderer/denoiser';
import {renderFixture} from '../helpers/renderPipeline';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
afterEach(() => {vi.restoreAllMocks();});

// Preserve the real Render/Engine lease, preparation and cancellation machinery.
// Only replace the GPU pass with a copyable image to isolate lifecycle behavior.
function fixture() {
  const result = renderFixture();
  const starts: string[] = [];
  const hook = (render: Render) => {
    render.refine();
    const target = result.targets.at(-1)!;
    vi.mocked(target.performDenoise!).mockImplementation(async (filter: DenoiserHandle, _alpha, schedule = 'converged', signal) => {
      if (filter.kind !== 'custom') throw new Error('Unexpected filter');
      const image = (values: number[]) => ({values}) as unknown as GPUBuffer;
      const input: DenoiseInput = {device: result.engine.device!, width: render.width, height: render.height,
        color: image([3, 2, 1, .5]), albedo: image([.3, .2, .1, .5]), normal: image([.5, .5, 1, 1]), output: image([0, 0, 0, 0])};
      starts.push(target.label);
      await filter.denoiser.denoise(input, {schedule, signal: signal!});
      return true;
    });
    return target;
  };
  return {...result, hook, starts};
}
function copyFilter() {
  return {prepare: vi.fn(async (_input: {device: GPUDevice; width: number; height: number}) => {}), denoise: vi.fn(async (input: DenoiseInput) => {
    const color = input.color as unknown as {values: number[]}, output = input.output as unknown as {values: number[]};
    output.values.splice(0, 4, ...color.values);
  }), dispose: vi.fn()};
}

describe('custom denoiser lifecycle', () => {
  it('mounts a caller-owned copy filter and prepares only when device or dimensions change', async () => {
    const {engine, hook, canvas} = fixture(); const filter = copyFilter();
    const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); hook(render); await settle();
    expect(filter.prepare).toHaveBeenCalledWith({device: engine.device, width: 800, height: 600});
    expect(filter.prepare.mock.invocationCallOrder[0]).toBeLessThan(filter.denoise.mock.invocationCallOrder[0]);
    const input = filter.denoise.mock.calls[0][0]; expect(input.output).toEqual(input.color);
    render.restart(); render.refine(); await settle(); expect(filter.prepare).toHaveBeenCalledOnce();
    canvas.width = 320; canvas.height = 240; render.refine(); await settle();
    expect(filter.prepare).toHaveBeenLastCalledWith({device: engine.device, width: 320, height: 240});
    (engine as unknown as {_gpuDevice: GPUDevice})._gpuDevice = {queue: {onSubmittedWorkDone: async () => {}}} as GPUDevice;
    render.restart(); render.refine(); await settle(); expect(filter.prepare).toHaveBeenCalledTimes(3);
    render.dispose(); engine.dispose(); expect(filter.dispose).not.toHaveBeenCalled();
  });

  it('prepares a shared instance again when switching from another render size', async () => {
    const {engine, hook} = fixture(); const filter = copyFilter();
    const a = new Render(engine, {width: 64, height: 64, maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    const b = new Render(engine, {width: 128, height: 96, maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); hook(a); hook(b); await settle(); a.restart(); a.refine(); await settle();
    expect(filter.prepare.mock.calls.map(([size]) => [size.width, size.height])).toEqual([[64, 64], [128, 96], [64, 64]]);
    engine.dispose(); expect(filter.dispose).not.toHaveBeenCalled();
  });

  it('keys by object identity and retains inference through equal assignments and schedule edits', async () => {
    const {engine, hook} = fixture(); let finish!: () => void; let signal!: AbortSignal;
    const filter = {prepare: vi.fn(async () => {}), toJSON() {throw new Error('Must not serialize');},
      denoise: vi.fn((_input: DenoiseInput, context: {signal: AbortSignal}) => {signal = context.signal; return new Promise<void>(resolve => {finish = resolve;});})};
    const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); hook(render); await settle(); const options = render.denoiser;
    render.setDenoiser({type: 'custom', denoiser: filter}); expect(render.denoiser).toBe(options);
    render.setDenoiser({type: 'custom', denoiser: filter, schedule: 'progressive'});
    expect(signal.aborted).toBe(false); expect(render.denoising).toBe(true);
    finish(); await settle(); expect(render.status).toBe('finished');
    const next = {...filter}; render.setDenoiser({type: 'custom', denoiser: next});
    expect(render.denoiser!.type).toBe('custom'); engine.dispose();
  });

  it.each(['input', 'restart', 'replace', 'render disposal', 'engine disposal'] as const)('aborts on %s and discards a late resolve', async action => {
    const {engine, camera, hook} = fixture(); let finish!: () => void; let signal!: AbortSignal;
    const filter = {dispose: vi.fn(), denoise: vi.fn((_input: DenoiseInput, context: {signal: AbortSignal}) => {
      signal = context.signal; return new Promise<void>(resolve => {finish = resolve;});
    })};
    const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); const target = hook(render); await settle();
    vi.mocked(target.drawPostProcess).mockClear();
    if (action === 'input') {camera.position = [1, 0, 0]; engine.update();}
    else if (action === 'restart') render.restart();
    else if (action === 'replace') render.setDenoiser(null);
    else if (action === 'render disposal') render.dispose();
    else engine.dispose();
    expect(signal.aborted).toBe(true); finish(); await settle();
    expect(target.drawPostProcess).not.toHaveBeenCalled(); expect(filter.dispose).not.toHaveBeenCalled();
    engine.dispose();
  });

  it('holds the engine lease until an aborted filter really settles', async () => {
    const {engine, hook, starts} = fixture(); let finish!: () => void; let signal!: AbortSignal;
    let calls = 0;
    const filter = {denoise: vi.fn((_input: DenoiseInput, context: {signal: AbortSignal}) => {
      signal = context.signal; return ++calls === 1 ? new Promise<void>(resolve => {finish = resolve;}) : Promise.resolve();
    })};
    const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    const b = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); hook(a); hook(b); await settle(); expect(starts).toEqual(['render-1']);
    a.restart(); await settle(); expect(signal.aborted).toBe(true); expect(starts).toEqual(['render-1']);
    finish(); await settle(); expect(starts).toEqual(['render-1', 'render-2']); engine.dispose();
  });

  it('discards a queued job on input changes before preparing or invoking the filter', async () => {
    const {engine, hook, camera} = fixture(); let finish!: () => void;
    const first = {denoise: vi.fn(() => new Promise<void>(resolve => {finish = resolve;}))}, second = copyFilter();
    const a = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: first}});
    const b = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: second}});
    await settle(); hook(a); hook(b); await settle(); camera.position = [1, 0, 0]; engine.update();
    finish(); await settle(); expect(second.prepare).not.toHaveBeenCalled(); expect(second.denoise).not.toHaveBeenCalled(); engine.dispose();
  });

  it('aborts while prepare is pending without invoking denoise', async () => {
    const {engine, hook} = fixture(); let finish!: () => void;
    const filter = {prepare: vi.fn(() => new Promise<void>(resolve => {finish = resolve;})), denoise: vi.fn(async () => {})};
    const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); hook(render); await settle(); render.restart(); finish(); await settle();
    expect(filter.denoise).not.toHaveBeenCalled(); engine.dispose();
  });

  it.each(['prepare', 'denoise'] as const)('reports a %s rejection through engine error events and frees the lease', async phase => {
    const {engine, hook} = fixture(); const failure = new Error(`${phase} failed`); const filter = copyFilter();
    filter[phase].mockRejectedValueOnce(failure); const errors = vi.fn(); engine.on('error', errors);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
    await settle(); hook(render); await settle(); expect(errors).toHaveBeenCalledWith(failure);
    render.restart(); render.refine(); await settle(); expect(render.status).toBe('finished'); engine.dispose();
  });

  it('warns once on WebGL without preparing, invoking or releasing the caller filter', async () => {
    const {engine} = renderFixture({backend: 'webgl'}); const filter = copyFilter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}}); await settle();
    expect(render.refine()).toBe('finished'); render.setDenoiser(null); render.setDenoiser({type: 'custom', denoiser: copyFilter()});
    await settle(); expect(warn).toHaveBeenCalledOnce(); expect(filter.prepare).not.toHaveBeenCalled(); expect(filter.denoise).not.toHaveBeenCalled();
    engine.dispose(); expect(filter.dispose).not.toHaveBeenCalled();
  });

  it('rejects an invalid custom interface before replacing the current filter', () => {
    const {engine} = renderFixture(); const render = new Render(engine, {denoiser: {type: 'jnlm'}}); const before = render.denoiser;
    for (const denoiser of [{}, {denoise: 'bad'}, {denoise() {}, prepare: 'bad'}]) {
      expect(() => {render.setDenoiser({type: 'custom', denoiser: denoiser as unknown as Denoiser});}).toThrow();
      expect(render.denoiser).toBe(before);
    }
    engine.dispose();
  });
});

it('propagates convergence cancellation into the active custom signal', async () => {
  const {engine, targets} = renderFixture(); let finish!: () => void; let signal!: AbortSignal;
  const filter = {denoise: vi.fn((_input: DenoiseInput, context: {signal: AbortSignal}) => {
    signal = context.signal; return new Promise<void>(resolve => {finish = resolve;});
  })};
  const render = new Render(engine, {maxSamples: 1, denoiser: {type: 'custom', denoiser: filter}});
  await settle(); render.refine();
  vi.mocked(targets[0].performDenoise!).mockImplementation(async (_filter, _alpha, schedule, contextSignal) => {
    await filter.denoise({} as DenoiseInput, {signal: contextSignal!}); expect(schedule).toBe('converged'); return true;
  });
  // Let the initial realtime job finish first, then start the cancellable offline job.
  await settle(); finish(); await settle();
  const controller = new AbortController(), failure = new Error('stop export');
  const pending = render.converge({samples: 1, signal: controller.signal});
  const rejected = expect(pending).rejects.toBe(failure);
  await vi.waitFor(() => expect(filter.denoise).toHaveBeenCalledTimes(2));
  controller.abort(failure); expect(signal.aborted).toBe(true); finish(); await rejected; engine.dispose();
});
