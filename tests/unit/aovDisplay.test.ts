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
  it('validates mappings and packs integer lanes separately from float32 ranges', () => {
    const words = packAovDisplay(48, 32, 4, 'id', { ...DEFAULT_AOV_DISPLAY, idComponent: 'primitive' }, false), f = new Float32Array(words.buffer);
    expect(Array.from(words.slice(0, 4))).toEqual([48, 32, 4, 5]);
    expect(Array.from(f.slice(4, 8))).toEqual([0, 10, 1, 16]);
    expect(words[8]).toBe(3);
    for (const change of [{ depthRange: [1, 1] }, { depthRange: [-1, 2] }, { depthRange: [0, Infinity] }, { depthRange: [1, 1 + 1e-10] }, { positionScale: 0 }, { positionScale: '1' }, { positionScale: 1e40 }, { motionScale: 1e-50 }, { idComponent: 'bad' }])
      expect(() => validateAovDisplay({ ...DEFAULT_AOV_DISPLAY, ...change } as never)).toThrow();
  });
});
