import { describe, it, expect, vi } from 'vitest';
import Render from '../../src/Render.js';
import RenderLoop from '../../src/RenderLoop.js';
import { renderFixture } from '../helpers/renderPipeline.js';
import { AOV_KINDS } from '../../src/renderer/aov.js';
import { DEFAULT_AOV_DISPLAY, packAovDisplay, validateAovDisplay } from '../../src/renderer/aovDisplay.js';
describe('AOV display channels', () => {
  it('selects declared outputs without restarting sampling or invalidating denoising', () => {
    const { engine, targets } = renderFixture();
    const render = new Render(engine, { aovs: AOV_KINDS });
    render.refine();
    engine.display.present(render);
    const changed = vi.spyOn(render, '_displayChanged');
    for (const channel of AOV_KINDS) {
      engine.display.channel = channel;
      engine.display.present(render);
      expect(targets[0].setOutput).toHaveBeenLastCalledWith(channel);
    }
    engine.display.aovDepthRange = [1, 50];
    engine.display.aovIdComponent = 'material';
    engine.display.present(render);
    expect(changed).not.toHaveBeenCalled();
    expect(targets[0].restartSamples).toHaveBeenCalledTimes(1);
    expect(render.samples).toBe(1);
    expect(render.aovs).toEqual(AOV_KINDS);
    engine.dispose();
  });
  it('requires explicit outputs on the selected render and leaves its image untouched on error', () => {
    const { engine, targets } = renderFixture();
    const render = new Render(engine);
    render.refine();
    engine.display.present(render);
    const draws = vi.mocked(targets[0].drawPostProcess).mock.calls.length;
    engine.display.channel = 'depth';
    expect(() => engine.display.present(render)).toThrow('not enabled');
    expect(targets[0].drawPostProcess).toHaveBeenCalledTimes(draws);
    expect(render.aovs).toEqual([]);
    expect(render.samples).toBe(1);
    engine.display.channel = 'normal';
    expect(() => engine.display.present(render)).not.toThrow();
    engine.dispose();
  });
  it('waits for a newly enabled output and wakes a finished loop for AOV settings', () => {
    const {engine, targets} = renderFixture();
    const loop = new RenderLoop(engine, {preview: false, final: {maxSamples: 1}});
    expect(loop.tick()).toBe('finished');
    const target = targets[0];
    let ready = false;
    target.aovReady = kind => ready && !!vi.mocked(target.configure).mock.calls.at(-1)?.[0].aovs?.includes(kind);
    target.getAovSamples = () => ready ? 1 : 0;
    target.refineAovs = vi.fn().mockReturnValueOnce(false).mockImplementation(() => { ready = true; return true; });
    loop.final.aovs = ['depth']; engine.display.channel = 'depth';
    const draws = vi.mocked(target.drawPostProcess).mock.calls.length;
    expect(engine.display.present(loop.final)).toBeUndefined();
    expect(target.drawPostProcess).toHaveBeenCalledTimes(draws);
    expect(loop.tick()).toBe('compiling');
    expect(loop.tick()).toBe('finished');
    expect(target.refineAovs).toHaveBeenCalledTimes(2);
    expect(loop.final.samples).toBe(1);
    expect(target.restartSamples).toHaveBeenCalledOnce();
    expect(target.trace).toHaveBeenCalledOnce();
    const present = vi.mocked(target.present).mock.calls.length;
    engine.display.aovDepthRange = [0, 20];
    expect(loop.tick()).toBe('finished');
    expect(vi.mocked(target.present).mock.calls.length).toBeGreaterThan(present);
    expect(target.trace).toHaveBeenCalledOnce();
    loop.dispose(); engine.dispose();
  });
  it.each(AOV_KINDS)('traces only surface outputs while viewing %s and resumes beauty on Final', async channel => {
    const {engine, targets, camera} = renderFixture();
    const loop = new RenderLoop(engine, {preview: false, final: {aovs: [channel], maxSamples: 4, aovSamples: 2, denoiser: {type: 'jnlm'}}});
    await new Promise(resolve => setTimeout(resolve, 0));
    engine.display.channel = channel;
    expect(loop.tick()).toBe(channel === 'id' || channel === 'motion' ? 'finished' : 'converging');
    for (let i = 0; i < 3; i++) loop.tick();
    const target = targets[0];
    expect(loop.status).toBe('finished'); expect(loop.samples).toBe(0);
    expect(loop.final.samples).toBe(0); expect(loop.final.converged).toBe(false);
    expect(target.trace).not.toHaveBeenCalled(); expect(target.performDenoise).not.toHaveBeenCalled();
    expect(target.present).toHaveBeenCalled(); expect(target.isFirstFrame()).toBe(true);
    expect(loop.final.aovSamplesRendered).toBe(channel === 'id' || channel === 'motion' ? 1 : 2);
    expect((await loop.final.readPixels('hdr')).data).toHaveLength(0);
    camera.position = [1, 0, 0]; engine.update(); loop.tick();
    expect(loop.final.samples).toBe(0); expect(target.trace).not.toHaveBeenCalled();
    expect(vi.mocked(target.refineAovs!).mock.calls.at(-1)?.[0].position).toEqual(camera.position);
    engine.display.channel = 'final'; loop.tick();
    expect(target.trace).toHaveBeenCalledOnce(); expect(loop.final.samples).toBe(1);
    loop.dispose(); engine.dispose();
  });
  it('keeps preview selection responsive without invoking beauty or filtering', () => {
    const {engine, targets, camera} = renderFixture();
    const loop = new RenderLoop(engine, {coalesceSceneUpdates: true, preview: {aovs: ['depth']}, final: {aovs: ['depth'], aovSamples: 1}});
    engine.display.channel = 'depth'; loop.select = () => 'preview';
    loop.tick(); camera.position = [1,0,0]; loop.tick();
    expect(loop.status).toBe('previewing');
    expect(targets.every(t => !vi.mocked(t.trace).mock.calls.length)).toBe(true);
    expect(loop.preview!._completeFor('depth')).toBe(true);
    loop.select = () => 'final'; loop.tick(); expect(loop.status).toBe('finished');
    expect(loop.final.samples).toBe(0);
    loop.dispose(); engine.dispose();
  });
  it('adapts preview resolution from surface-only frames without adding beauty samples', () => {
    const {engine} = renderFixture();
    let frame!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {frame = callback; return 1;});
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const render = new Render(engine, {aovs: ['depth'], adaptiveResolution: {targetFrameMs: 10, minScale: .25}});
    try {
      render.refine('depth'); const width = render.width;
      now.mockReturnValue(90); frame(90); render.refine('depth');
      expect(render.width).toBeLessThan(width); expect(render.samples).toBe(0);
    } finally {engine.dispose(); now.mockRestore(); vi.unstubAllGlobals();}
  });
  it('keeps direct refine/converge on the beauty path with an AOV display selected', async () => {
    const {engine, targets} = renderFixture(); const render = new Render(engine, {aovs: ['depth'], maxSamples: 2});
    engine.display.channel = 'depth'; render.refine(); expect(render.samples).toBe(1);
    await render.converge({samples: 2});
    expect(render.samples).toBe(2); expect(targets[0].trace).toHaveBeenCalled(); engine.dispose();
  });
  it('validates mappings and packs integer lanes separately from float32 ranges', () => {
    const words = packAovDisplay(48, 32, 4, 'id', { ...DEFAULT_AOV_DISPLAY, idComponent: 'primitive' }, false), f = new Float32Array(words.buffer);
    expect(Array.from(words.slice(0, 4))).toEqual([48, 32, 4, 5]);
    expect(Array.from(f.slice(4, 8))).toEqual([0, 10, 1, 16]);
    expect(words[8]).toBe(3);
    for (const change of [{ depthRange: [1, 1] }, { depthRange: [-1, 2] }, { depthRange: [0, Infinity] }, { depthRange: [1, 1 + 1e-10] }, { positionScale: 0 }, { positionScale: '1' }, { positionScale: 1e40 }, { motionScale: 1e-50 }, { idComponent: 'bad' }])
      expect(() => validateAovDisplay({ ...DEFAULT_AOV_DISPLAY, ...change } as never)).toThrow();
  });
});
