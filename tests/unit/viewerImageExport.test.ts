/// <reference lib="dom.iterable" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerEngine as Engine } from '../../viewer/src/engine/ViewerEngine';
import type { useViewer as Store } from '../../viewer/src/store';

vi.mock('@meimu/mutracer', async () => import('../../src/main'));

let ViewerEngine: typeof Engine;
let useViewer: typeof Store;

beforeAll(async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost:3012/' });
  vi.stubGlobal('location', { hash: '' });
  ({ ViewerEngine } = await import('../../viewer/src/engine/ViewerEngine'));
  ({ useViewer } = await import('../../viewer/src/store'));
  vi.unstubAllGlobals();
});

describe('viewer viewport image download', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useViewer.setState({ model: null, export: null, toast: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fixture(blob: Blob | null = new Blob(['PNG'], { type: 'image/png' })) {
    const link = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: vi.fn(() => link) });
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:viewport');
    const revokeURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const renderer = {
      prepareForExport: vi.fn(),
      samples: 32,
      restartSamples: vi.fn(),
      setSize: vi.fn(),
      renderOfflineFrame: vi.fn()
    };
    const canvas = {
      width: 800, height: 600,
      toBlob: vi.fn((resolve: BlobCallback) => {
        expect(renderer.prepareForExport).toHaveBeenCalledOnce();
        resolve(blob);
      })
    };
    // Exercise export behavior without constructing a GPU or starting the render loop.
    const engine: Engine = Object.assign(Object.create(ViewerEngine.prototype), {
      renderer, canvas, exporting: false
    });
    return { engine, renderer, canvas, link, blob, createURL, revokeURL };
  }

  it('captures the displayed canvas without resizing or restarting accumulation', async () => {
    const { engine, renderer, canvas, link, blob, createURL, revokeURL } = fixture();
    useViewer.setState({ model: { name: 'scene.glb' } as NonNullable<ReturnType<typeof useViewer.getState>['model']> });
    const settings = useViewer.getState().settings;
    await engine.downloadViewportImage();

    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(renderer.restartSamples).not.toHaveBeenCalled();
    expect(renderer.setSize).not.toHaveBeenCalled();
    expect(renderer.renderOfflineFrame).not.toHaveBeenCalled();
    expect(useViewer.getState().settings).toBe(settings);
    expect(useViewer.getState().export).toBeNull();
    expect(createURL).toHaveBeenCalledWith(blob);
    expect(link.download).toBe('mutracer-scene-viewport-32spp.png');
    expect(link.click).toHaveBeenCalledOnce();
    expect(useViewer.getState().toast?.tone).toBe('info');
    vi.advanceTimersByTime(10_000);
    expect(revokeURL).toHaveBeenCalledWith('blob:viewport');
  });

  it('reports encoding failures without downloading an empty image', async () => {
    const { engine, link } = fixture(null);
    await engine.downloadViewportImage();
    expect(link.click).not.toHaveBeenCalled();
    expect(useViewer.getState().toast).toMatchObject({
      tone: 'error', message: 'Export failed: The canvas could not be encoded'
    });
  });

  it('does not capture an unrendered viewport', async () => {
    const { engine, renderer, canvas } = fixture();
    renderer.samples = 0;
    await engine.downloadViewportImage();
    expect(canvas.toBlob).not.toHaveBeenCalled();
    expect(useViewer.getState().toast?.tone).toBe('error');
  });

  it('does not capture an in-progress offline export', async () => {
    const { engine, canvas } = fixture();
    Object.assign(engine, { exporting: true });
    await engine.downloadViewportImage();
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });
});
