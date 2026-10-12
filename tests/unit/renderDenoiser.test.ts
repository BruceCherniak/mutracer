import { afterEach, describe, expect, it, vi } from 'vitest';
const { initializeOIDN } = vi.hoisted(() => ({initializeOIDN: vi.fn()}));
vi.mock('../../src/oidn', () => ({initializeOIDN}));
import Render from '../../src/Render';
import { renderFixture } from '../helpers/renderPipeline';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function filter() { return {tileExecute: vi.fn(), dispose: vi.fn(), prepareForImage: vi.fn(async () => {})}; }
afterEach(() => { initializeOIDN.mockReset(); });

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
