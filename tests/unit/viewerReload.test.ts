/// <reference lib="dom" />
import { webcrypto } from 'node:crypto';
import { File } from 'node:buffer';
import * as THREE from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerEngine as Engine } from '../../viewer/src/engine/ViewerEngine';
import type { useViewer as Store } from '../../viewer/src/store';
import type { CachedModel } from '../../viewer/src/engine/modelCache';

const cache = vi.hoisted(() => ({ model: null as CachedModel | null, read: vi.fn(), save: vi.fn(), clear: vi.fn() }));
vi.mock('../../viewer/src/engine/modelCache', () => ({
  readModelCache: cache.read, saveModelCache: cache.save, clearModelCache: cache.clear,
  readMaterialEdits: async () => null, saveMaterialEdits: async () => {}, clearMaterialEdits: async () => {}
}));
vi.mock('@meimu/mutracer', async () => ({
  DEFAULT_JNLM_OPTIONS: (await import('../../src/renderer/jnlm')).DEFAULT_JNLM_OPTIONS,
  Renderer: class {
    samples = 0;
    init() { return Promise.resolve({backend:'webgl',adapterName:'mock'}); }
    getSize() { return { width: 800, height: 600 }; }
    setSize() {}
    readDepthSamples = vi.fn(async () => new Float32Array(49).fill(4));
    dispose() {}
  },
  THREESceneSync: class {
    scene = { meshes: [] };
    dispose() {}
  }
}));
vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const { EventDispatcher, Vector3 } = await import('three');
  return { OrbitControls: class extends EventDispatcher {
    target = new Vector3();
    constructor(private camera: THREE.Camera) { super(); }
    update() { this.camera.lookAt(this.target); this.dispatchEvent({ type: 'change' } as never); }
    dispose() {}
  } };
});

let ViewerEngine: typeof Engine;
let useViewer: typeof Store;
let defaults: ReturnType<typeof Store.getState>['settings'];

beforeAll(async () => {
  vi.stubGlobal('document', { baseURI: 'http://localhost:3012/' });
  vi.stubGlobal('location', { hash: '' });
  ({ ViewerEngine } = await import('../../viewer/src/engine/ViewerEngine'));
  const store = await import('../../viewer/src/store');
  useViewer = store.useViewer;
  defaults = store.DEFAULT_SETTINGS;
  vi.unstubAllGlobals();
});

describe('viewer reload lifecycle', () => {
  const engines: Engine[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    vi.stubGlobal('location', { hash: '', search: '', pathname: '/' });
    vi.stubGlobal('history', { replaceState: vi.fn() });
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('File', File);
    vi.stubGlobal('window', new EventTarget());
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    cache.model = null;
    cache.read.mockReset().mockImplementation(async () => cache.model);
    cache.save.mockReset().mockImplementation(async (model: CachedModel) => { cache.model = model; });
    cache.clear.mockReset().mockImplementation(async () => { cache.model = null; });
    useViewer.setState({ settings: { ...defaults, envId: 'sky' }, model: null, toast: null, loading: null });
  });
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function engine() {
    const canvas = Object.assign(new EventTarget(), { clientWidth: 800, clientHeight: 600 });
    const instance = new ViewerEngine(canvas as unknown as HTMLCanvasElement);
    engines.push(instance);
    return instance;
  }

  async function flushFocus() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  function publish(viewer: Engine, phase: 'preparing' | 'compiling' | 'rendering' | 'finished' | 'error' | 'paused', samples: number) {
    const internal = viewer as unknown as {
      renderer: { samples: number };
      publishStats(phase: string, now: number, force: boolean): void;
    };
    internal.renderer.samples = samples;
    internal.publishStats(phase, 1000, true);
  }

  it('keeps the loading stages visible while preparation retains old scene samples', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    publish(viewer, 'preparing', 64);
    expect(useViewer.getState().loading?.stage).toBe('bvh');
    publish(viewer, 'compiling', 64);
    expect(useViewer.getState().loading?.stage).toBe('shaders');
    publish(viewer, 'rendering', 0);
    expect(useViewer.getState().loading?.stage).toBe('shaders');
    publish(viewer, 'rendering', 1);
    expect(useViewer.getState().loading).toBeNull();
  });

  it('keeps focus while scrubbing aperture and measures again when depth of field is re-enabled', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    const measure = vi.spyOn(viewer.renderer, 'readDepthSamples');
    const internal = viewer as unknown as { lastViewChange: number; updateAutofocus(now: number): void };
    const update = async () => {
      internal.lastViewChange = 0;
      internal.updateAutofocus(performance.now() + 1000);
      await flushFocus();
    };
    try {
      useViewer.setState((s) => ({ settings: { ...s.settings, fStop: 2.8, autoFocus: true, autoRotate: false }, animation: null }));
      await update();
      expect(measure).toHaveBeenCalledTimes(1);
      for (const fStop of [1.4, 4, 8, 16]) {
        useViewer.setState((s) => ({ settings: { ...s.settings, fStop } }));
        await update();
      }
      expect(measure).toHaveBeenCalledTimes(1);
      useViewer.setState((s) => ({ settings: { ...s.settings, fStop: 0 } }));
      await update();
      expect(measure).toHaveBeenCalledTimes(1);
      useViewer.setState((s) => ({ settings: { ...s.settings, fStop: 2.8 } }));
      await update();
      expect(measure).toHaveBeenCalledTimes(2);
      useViewer.setState((s) => ({ settings: { ...s.settings, fov: 45 } }));
      await update();
      expect(measure).toHaveBeenCalledTimes(3);
    } finally {
      measure.mockRestore();
    }
  });

  it('keeps a single GPU focus query in flight and ignores an outdated area', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    useViewer.setState(s => ({ settings: { ...s.settings, fStop: 2.8, autoFocus: true, autoRotate: false }, animation: null }));
    const internal = viewer as unknown as { lastViewChange: number; updateAutofocus(now: number): void; startPull: (depth: number, now: number, announce: boolean) => void };
    const pull = vi.spyOn(internal, 'startPull');
    let resolve!: (samples: Float32Array) => void;
    const query = vi.spyOn(viewer.renderer, 'readDepthSamples').mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    internal.lastViewChange = 0;
    internal.updateAutofocus(1000);
    internal.updateAutofocus(2000);
    expect(query).toHaveBeenCalledTimes(1);
    useViewer.setState(s => ({ focusArea: { ...s.focusArea, x: 0.8 } }));
    resolve(new Float32Array(49).fill(9));
    await flushFocus();
    expect(pull).not.toHaveBeenCalled();
    internal.lastViewChange = 0;
    internal.updateAutofocus(3000);
    await flushFocus();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith({ x: 0.8, y: useViewer.getState().focusArea.y, size: 0.07 });
    expect(pull).toHaveBeenCalledWith(4, expect.any(Number), true);
  });

  it('retries unprepared depth queries and accepts delayed continuous tracking results', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    useViewer.setState(s => ({ settings: { ...s.settings, fStop: 2.8, autoFocus: true, autoRotate: true }, animation: null }));
    const internal = viewer as unknown as { lastViewChange: number; updateAutofocus(now: number): void; startPull: (depth: number, now: number, announce: boolean) => void };
    const pull = vi.spyOn(internal, 'startPull');
    let resolve!: (samples: Float32Array) => void;
    const query = vi.spyOn(viewer.renderer, 'readDepthSamples')
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    internal.updateAutofocus(1000);
    await flushFocus();
    expect(pull).not.toHaveBeenCalled();
    internal.updateAutofocus(1016);
    internal.lastViewChange = 1016;
    resolve(new Float32Array(49).fill(3));
    await flushFocus();
    expect(query).toHaveBeenCalledTimes(2);
    expect(pull).toHaveBeenCalledWith(3, expect.any(Number), false);
  });

  it('queues manual GPU focus picks and discards them after a slider change or disposal', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    useViewer.setState(s => ({ settings: { ...s.settings, fStop: 2.8, autoFocus: false } }));
    const internal = viewer as unknown as { updateAutofocus(now: number): void; startPull: (depth: number, now: number, announce: boolean) => void };
    const pull = vi.spyOn(internal, 'startPull');
    let resolve!: (samples: Float32Array) => void;
    const query = vi.spyOn(viewer.renderer, 'readDepthSamples').mockImplementation(() => new Promise(r => { resolve = r; }));
    viewer.pickFocus(0.3, 0.4);
    expect(query).not.toHaveBeenCalled();
    internal.updateAutofocus(1000);
    expect(query).toHaveBeenCalledWith({ x: 0.3, y: 0.4, size: 0.004 });
    useViewer.setState(s => ({ settings: { ...s.settings, focusDistance: 7 } }));
    resolve(new Float32Array(49).fill(2));
    await flushFocus();
    expect(pull).not.toHaveBeenCalled();
    viewer.pickFocus(0.6, 0.7);
    internal.updateAutofocus(2000);
    viewer.dispose();
    resolve(new Float32Array(49).fill(2));
    await flushFocus();
    expect(pull).not.toHaveBeenCalled();
  });

  it('does not let the previous model hide or overwrite a new download stage', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    const loading = viewer.loadPreset('spheres');
    expect(useViewer.getState().loading?.stage).toBe('download');
    publish(viewer, 'rendering', 64);
    expect(useViewer.getState().loading?.stage).toBe('download');
    await loading;
    expect(useViewer.getState().loading?.stage).toBe('bvh');
    publish(viewer, 'preparing', 64);
    expect(useViewer.getState().loading?.stage).toBe('bvh');
  });

  it('keeps a paused load visible and dismisses it when rendering fails', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    publish(viewer, 'paused', 64);
    expect(useViewer.getState().loading).not.toBeNull();
    publish(viewer, 'error', 64);
    expect(useViewer.getState().loading).toBeNull();
  });

  it('restores the orbit and lens after automatic model fitting on reload', async () => {
    const first = engine();
    await first.loadPreset('spheres');
    first.lookAt(new THREE.Vector3(7, 3, 11), new THREE.Vector3(1, 0.4, -2));
    useViewer.setState((s) => ({ settings: { ...s.settings, fov: 47, fStop: 2.8, focusDistance: 8.75, metersPerUnit: 0.01 } }));
    // pagehide flushes even when the scheduled write has not fired.
    window.dispatchEvent(new Event('pagehide'));
    first.dispose();
    engines.splice(engines.indexOf(first), 1);
    useViewer.setState({ settings: { ...defaults, envId: 'sky' } });
    const second = engine();
    await second.loadInitialModel('spheres');
    const view = second as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3 } };
    expect(view.camera.position.toArray()).toEqual([7, 3, 11]);
    expect(view.controls.target.toArray()).toEqual([1, 0.4, -2]);
    expect(view.camera.fov).toBe(47);
    expect(useViewer.getState().settings).toMatchObject({ fStop: 2.8, focusDistance: 8.75, metersPerUnit: 0.01, cameraIndex: -1 });
    expect(useViewer.getState().model?.presetId).toBe('spheres');
  });

  it('ignores a pending initial restore if a newer model was opened', async () => {
    let resolve!: (model: CachedModel) => void;
    cache.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const viewer = engine();
    const initial = viewer.loadInitialModel(null);
    await viewer.loadPreset('spheres');
    resolve({ id: 'old', meta: { name: 'Old scene', presetId: 'spheres', credit: null, sourceUrl: null } });
    await initial;
    expect(useViewer.getState().model?.name).toBe('Material spheres');
    expect(cache.save).toHaveBeenCalledOnce();
  });

  it('reopens a local model and its selected glTF camera without a preset link', async () => {
    const data = JSON.stringify({
      asset: { version: '2.0' },
      cameras: [{ name: 'Model camera', type: 'perspective', perspective: { yfov: 0.6, znear: 0.01, zfar: 100 } }],
      nodes: [{ camera: 0, translation: [0, 2, 5] }], scenes: [{ nodes: [0] }], scene: 0
    });
    const first = engine();
    await first.loadFiles([{ path: 'folder/local.gltf', file: new File([data], 'local.gltf') as unknown as globalThis.File }]);
    const cameras = useViewer.getState().cameras;
    useViewer.setState((s) => ({ settings: { ...s.settings, cameraIndex: 0, fStop: 4, focusDistance: 3 } }));
    window.dispatchEvent(new Event('pagehide'));
    first.dispose();
    engines.splice(engines.indexOf(first), 1);
    useViewer.setState({ settings: { ...defaults, envId: 'sky' } });
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Offline'); }));
    await engine().loadInitialModel(null);
    expect(useViewer.getState().model).toMatchObject({ name: 'local.gltf', presetId: null });
    expect(useViewer.getState().cameras).toEqual(cameras);
    expect(useViewer.getState().settings).toMatchObject({ cameraIndex: 0, fStop: 4, focusDistance: 3 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the current model and cache if the next model fails to parse', async () => {
    const viewer = engine();
    await viewer.loadPreset('spheres');
    const previous = cache.model;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad glTF')));
    await viewer.loadUrl('https://example.com/bad.gltf');
    expect(cache.model).toBe(previous);
    expect(useViewer.getState().model?.presetId).toBe('spheres');
    expect(useViewer.getState().toast?.tone).toBe('error');
  });

  it('an explicit preset replaces a different cached model', async () => {
    cache.model = { id: 'old', meta: { name: 'Old', presetId: 'helmet', credit: null, sourceUrl: null } };
    await engine().loadInitialModel('spheres');
    expect(cache.model?.meta.presetId).toBe('spheres');
    expect(useViewer.getState().model?.name).toBe('Material spheres');
  });

  it('redownloads a URL model if its cached source cannot be parsed', async () => {
    cache.model = {
      id: 'remote', meta: { name: 'remote.gltf', presetId: null, credit: null, sourceUrl: 'https://example.com/remote.gltf' },
      source: { mainPath: 'remote.gltf', base: '', files: [{ path: 'remote.gltf', file: new File(['invalid'], 'remote.gltf') as unknown as globalThis.File }] }
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0 }))));
    await engine().loadInitialModel(null);
    expect(fetch).toHaveBeenCalledOnce();
    expect(useViewer.getState().model?.name).toBe('remote.gltf');
    expect(cache.model?.id).toBe('remote');
  });
});
