import { afterEach, describe, expect, it, vi } from 'vitest';
import Render from '../../src/Render';
import { renderFixture } from '../helpers/renderPipeline';
afterEach(() => { vi.unstubAllGlobals(); });

describe('Display', () => {
  it('presents guide channels immediately while the first final filter is pending', () => {
    const {engine} = renderFixture();
    const preview = new Render(engine); preview.refine();
    const render = new Render(engine, {fallback: preview, denoiser: {type: 'jnlm', schedule: 'progressive'}});
    render.refine(); expect(engine.display.present(render)).toBe(preview);
    engine.display.channel = 'normal'; expect(engine.display.present(render)).toBe(render);
    engine.dispose();
  });
  it('allows standalone renders to present raw samples during intermediate filtering', () => {
    const {engine} = renderFixture();
    const render = new Render(engine, {denoiser: {type: 'jnlm', schedule: 'progressive'}});
    render.refine(); expect(render.denoising).toBe(true);
    expect(engine.display.present(render)).toBe(render); engine.dispose();
  });
  it.each(['progressive', 'every-sample'] as const)('keeps fallback until the first %s filter completes', async schedule => {
    const {engine, targets} = renderFixture(); const preview = new Render(engine, {maxSamples: 1});
    const final = new Render(engine, {maxSamples: 4, fallback: preview, denoiser: {type: 'jnlm', schedule}});
    preview.refine(); expect(engine.display.present(preview)).toBe(preview);
    final.refine(); let complete!: (value: boolean) => void;
    vi.mocked(targets[1].performDenoise!).mockImplementation(() => new Promise(resolve => {complete = resolve;}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(final.samples).toBe(1); expect(engine.display.present(final)).toBe(preview);
    expect(targets[1].present).not.toHaveBeenCalled();
    complete(true); await new Promise(resolve => setTimeout(resolve, 0));
    // Refining before presenting must retain the completed filter too.
    final.refine(); expect(engine.display.present(final)).toBe(final);
    expect(targets[1].setPreserveDenoisedOutput).toHaveBeenLastCalledWith(true);
    engine.dispose();
  });
  it('presents the complete fallback and otherwise leaves the canvas untouched', () => {
    const {engine, targets} = renderFixture({tiles: 3}); const preview = new Render(engine), final = new Render(engine, {fallback: preview});
    expect(engine.display.present(final)).toBeUndefined(); preview.refine(); preview.refine(); preview.refine();
    final.refine(); expect(engine.display.present(final)).toBe(preview); expect(targets[0].present).toHaveBeenCalledOnce();
    const drawCalls = vi.mocked(targets[0].trace).mock.calls.length; engine.display.present(final); expect(targets[0].trace).toHaveBeenCalledTimes(drawCalls);
    final.refine(); final.refine(); expect(engine.display.present(final)).toBe(final); engine.dispose();
  });
  it('applies display settings only to the specified output without restarting traces', () => {
    const {engine, targets, pipeline} = renderFixture(); const a = new Render(engine), b = new Render(engine); a.refine(); b.refine();
    engine.display.bloomIntensity = .4; engine.display.channel = 'normal'; engine.display.toneMappingExposure = 2;
    engine.display.present(a);
    expect(targets[0].setBloomParams).toHaveBeenCalledWith({intensity: .4, threshold: 1, radius: .6});
    expect(targets[0].setOutput).toHaveBeenCalledWith('normal'); expect(targets[1].setOutput).not.toHaveBeenCalled();
    expect([a.samples, b.samples]).toEqual([1, 1]); expect(pipeline.setMeshes).toHaveBeenCalledOnce(); engine.dispose();
  });
  it('exports fixed dimensions without prior present or changes to the display canvas', async () => {
    const {engine, canvas, targets, operations} = renderFixture(); const render = new Render(engine, {width: 256, height: 256}); render.refine();
    const image = vi.fn(); const blob = new Blob(['encoded'], {type: 'image/png'});
    const encodingCanvas = {width: 0, height: 0, getContext: () => ({putImageData: image}), toBlob: vi.fn((done: (blob: Blob) => void) => done(blob))};
    vi.stubGlobal('document', {createElement: vi.fn(() => encodingCanvas)});
    vi.stubGlobal('ImageData', class {constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}});
    expect(await engine.display.toBlob(render)).toBe(blob); expect([encodingCanvas.width, encodingCanvas.height]).toEqual([256, 256]);
    expect([canvas.width, canvas.height]).toEqual([800, 600]); expect(operations.some(o => o.kind === 'present')).toBe(false);
    expect(targets[0].readPresentation).toHaveBeenCalledOnce(); engine.dispose();
  });
  it('rejects foreign-engine presentation and encoding', async () => {
    const a = renderFixture(), b = renderFixture(); const render = new Render(b.engine); render.refine();
    expect(() => a.engine.display.present(render)).toThrow('another engine'); await expect(a.engine.display.toBlob(render)).rejects.toThrow('another engine'); a.engine.dispose(); b.engine.dispose();
  });
});
