import { describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import { renderFixture } from '../helpers/renderPipeline';

describe('independent Render', () => {
  it('accumulates three interleaved outputs and selects the requested read/present target', async () => {
    const {engine, targets, operations} = renderFixture();
    const a = new Render(engine), b = new Render(engine), c = new Render(engine, {width: 256, height: 256});
    a.refine(); b.refine(); c.refine(); a.refine(); b.refine(); a.refine();
    expect([a.samples, b.samples, c.samples]).toEqual([3, 2, 1]);
    expect((await a.readPixels()).data.slice(0, 2)).toEqual(new Float32Array([1, 3]));
    expect((await c.readPixels()).width).toBe(256);
    expect(engine.display.present(b)).toBe(b);
    expect(operations.filter(o => o.kind === 'present').map(o => o.id)).toEqual([targets[1].label]);
    c.dispose(); expect(targets[2].dispose).toHaveBeenCalledOnce();
    a.refine(); expect(a.samples).toBe(4); expect(() => c.refine()).toThrow('disposed');
    engine.dispose();
  });
  it('uses committed camera state until update and restarts all renders afterwards', () => {
    const {engine, camera, targets, operations} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    a.refine(); b.refine(); camera.position = [3, 0, 1]; a.refine();
    expect(a.samples).toBe(2); expect(operations.filter(o => o.kind === 'draw').at(-1)?.camera?.position).toEqual([0, 0, 0]);
    expect(engine.update()).toBe(true); expect([a.samples, b.samples]).toEqual([0, 0]);
    a.refine(); b.refine(); expect([a.samples, b.samples]).toEqual([1, 1]);
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(2);
    expect(operations.filter(o => o.kind === 'draw').at(-1)?.camera?.position).toEqual([3, 0, 1]);
    expect(engine.update()).toBe(false); engine.dispose();
  });
  it('invalidates only the render whose image settings changed, including transmissive alpha', () => {
    const {engine, targets} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    a.refine(); b.refine(); a.bounces = 8; a.refine(); b.refine(); expect([a.samples, b.samples]).toEqual([1, 2]);
    a.transmissiveOutputAlphaMin = .25; a.refine(); expect(a.samples).toBe(1);
    expect(targets[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({transmissiveOutputAlphaMin: .25}));
    engine.display.toneMappingExposure = 2; engine.display.present(a); expect(a.samples).toBe(1);
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(3); engine.dispose();
  });
  it('resizes scaled outputs and keeps fixed dimensions independent of the canvas', () => {
    const {engine} = renderFixture(); const a = new Render(engine, {resolutionScale: .5}), b = new Render(engine, {width: 256, height: 256});
    a.refine(); b.refine(); expect([a.width, a.height, b.width, b.height]).toEqual([400, 300, 256, 256]);
    engine.display.setSize(1024, 768); a.refine(); b.refine(); expect([a.width, a.height, b.width, b.height]).toEqual([512, 384, 256, 256]);
    expect([a.samples, b.samples]).toEqual([1, 2]); expect(() => {b.resolutionScale = .5;}).toThrow('Fixed-size');
    expect(() => new Render(engine, {width: 10} as never)).toThrow('width and height'); engine.dispose();
  });
  it('changes execution budgets without restarting accumulated input', () => {
    const {engine} = renderFixture(); const render = new Render(engine); render.refine();
    render.timeBudgetMs = 50; render.maxTiles = 1; render.allowMultipleSamplesPerFrame = true; render.refine();
    expect(render.samples).toBe(2); engine.dispose();
  });
  it('uses independent restarts and terminal sample counts', () => {
    const {engine} = renderFixture(); const a = new Render(engine, {maxSamples: 2}), b = new Render(engine);
    expect(a.refine()).toBe('converging'); expect(a.refine()).toBe('finished'); expect(a.converged).toBe(true);
    b.refine(); a.restart(); expect(a.samples).toBe(0); expect(b.samples).toBe(1); a.refine(); expect(a.samples).toBe(1); engine.dispose();
  });
});

describe('fallback', () => {
  it('fills a stale fallback once when the first final sample will exceed the frame budget', () => {
    const {engine, targets} = renderFixture({tiles: 3, fits: false});
    const preview = new Render(engine), final = new Render(engine, {fallback: preview});
    final.refine(); final.refine(); final.refine();
    expect(targets[1].trace).toHaveBeenCalledTimes(3); expect(final.samples).toBe(1); expect(preview.samples).toBe(1);
    final.refine(); expect(targets[1].trace).toHaveBeenCalledTimes(3); engine.dispose();
  });
  it('does not refine a current fallback or one unnecessary for a fast final', () => {
    const {engine, targets} = renderFixture({fits: false});
    const preview = new Render(engine), final = new Render(engine, {fallback: preview});
    preview.refine(); final.refine(); expect(targets[0].trace).toHaveBeenCalledOnce(); engine.dispose();
    const f = renderFixture(); const p = new Render(f.engine), r = new Render(f.engine, {fallback: p}); r.refine();
    expect(p.samples).toBe(0); f.engine.dispose();
  });
  it('rejects chains, cycles and foreign-engine fallbacks at construction and mutation', () => {
    const {engine} = renderFixture(); const other = renderFixture();
    const a = new Render(engine), b = new Render(engine, {fallback: a});
    expect(() => new Render(engine, {fallback: b})).toThrow('fallback');
    expect(() => {a.fallback = new Render(engine);}).toThrow('Fallback renders');
    expect(() => {a.fallback = a;}).toThrow('Fallback');
    expect(() => new Render(engine, {fallback: new Render(other.engine)})).toThrow('same engine');
    engine.dispose(); other.engine.dispose();
  });
});

describe('converge selects one render', () => {
  it('uses a camera copy, preserves the engine camera and excludes other targets', async () => {
    const {engine, camera, targets, operations} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    b.refine(); const exportCamera = camera.clone(); exportCamera.position = [8, 1, 2];
    const pending = a.converge({samples: 4, camera: exportCamera, sampleSequenceOffset: 19}); exportCamera.position = [9, 9, 9];
    expect(() => a.refine()).toThrow('converge'); b.refine();
    const result = await pending; expect(result.samples).toBe(4); expect(a.samples).toBe(4); expect(b.samples).toBe(2);
    expect(engine.camera).toBe(camera); expect(camera.position).toEqual([0, 0, 0]);
    expect(operations.filter(o => o.kind === 'draw' && o.id === targets[1].label).every(o => o.camera?.position[0] === 8)).toBe(true);
    expect((await a.readPixels()).data.slice(0, 2)).toEqual(new Float32Array([2, 4]));
    a.refine(); expect(a.samples).toBe(1); expect(operations.filter(o => o.kind === 'draw').at(-1)?.camera?.position).toEqual([0, 0, 0]); engine.dispose();
  });
  it('rejects an engine input update and permits the other render to use it', async () => {
    const {engine, camera} = renderFixture(); const a = new Render(engine), b = new Render(engine);
    await expect(a.converge({samples: 4, onProgress: () => {camera.position = [3, 2, 1]; engine.update();}})).rejects.toThrow('inputs changed');
    expect(a.status).toBe('error'); b.refine(); expect(b.samples).toBe(1); engine.dispose();
  });
  it('honors abort, timeout and WebGL adaptive fail-soft', async () => {
    const {engine} = renderFixture({backend: 'webgl'}); const render = new Render(engine);
    const controller = new AbortController(); const reason = new Error('cancel'); controller.abort(reason);
    await expect(render.converge({samples: 4, signal: controller.signal})).rejects.toBe(reason);
    const result = await render.converge({samples: 2, adaptiveSampling: {pilotSamples: 8}}); expect(result.adaptiveSampling).toBe(false); expect(result.samples).toBe(2);
    engine.dispose();
    const f = renderFixture({tiles: Infinity}); const r = new Render(f.engine); await expect(r.converge({samples: 1, timeoutMs: 1})).rejects.toThrow('Timed out'); f.engine.dispose();
  });
  it('runs the pilot on this target with a disjoint final sequence', async () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine); render.refine();
    const history = {width: 1, height: 1, tileSize: 1, columns: 1, rows: 1, meanLuminance: new Float32Array(1), variance: new Float32Array(1), sampleTargets: new Uint32Array(1)};
    vi.mocked(targets[0].prepareOfflineAdaptiveSampling).mockResolvedValue({maximumTarget: 3, averageTarget: 2, history});
    const result = await render.converge({samples: 8, adaptiveSampling: {pilotSamples: 2}, sampleSequenceOffset: 10});
    expect(result).toMatchObject({samples: 3, averageSamplesPerPixel: 2, pilotSamples: 2, adaptiveSampling: true});
    expect(targets[0].setOfflineRenderOptions).toHaveBeenCalledWith(expect.objectContaining({sampleSequenceOffset: 12})); engine.dispose();
  });
});
