/// <reference lib="dom" />
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedModel } from '../src/engine/loadModel';
import type { CachedModel } from '../src/engine/modelCache';

vi.hoisted(() => {
  vi.stubGlobal('location', { href: 'https://viewer.example.com/', search: '', hash: '', pathname: '/' });
  vi.stubGlobal('document', { baseURI: 'https://viewer.example.com/' });
  vi.stubGlobal('window', {});
  vi.stubGlobal('history', { replaceState: vi.fn() });
});
vi.mock('../src/engine/modelCache', () => ({
  clearMaterialEdits: vi.fn(), clearModelCache: vi.fn(), saveModelCache: vi.fn(), readMaterialEdits: vi.fn()
}));
import { ViewerEngine } from '../src/engine/ViewerEngine';
import { DEFAULT_SETTINGS, setSettings, useViewer, type Settings } from '../src/store';

// Exercise the real load/setModel/resetView path; replace GPU synchronization
// and persistence with inert boundaries so these tests run without a device.
function engine() {
  const viewer = Object.create(ViewerEngine.prototype);
  Object.assign(viewer, {
    loadToken: 0, model: null, modelId: null, modelCameras: [],
    modelGroup: new THREE.Group(), hiddenAtLoad: new Set(), ground: new THREE.Mesh(),
    canvas: { clientWidth: 800, clientHeight: 600 }, needsResize: false,
    perspectiveCamera: new THREE.PerspectiveCamera(35, 4 / 3),
    orthographicCamera: new THREE.OrthographicCamera(),
    controls: { target: new THREE.Vector3(), update: vi.fn() },
    materials: { flush: vi.fn(), setModel: vi.fn() },
    loop: { removeSync: vi.fn(), addSync: vi.fn() }, sync: { dispose: vi.fn() },
    createSync: () => ({ dispose: vi.fn() }),
    applyStudioRig: vi.fn(), applyBackground: vi.fn(), requestAutofocus: vi.fn(),
    saveCamera: vi.fn(), restoreCamera: vi.fn(() => false)
  });
  Object.defineProperty(viewer, 'settings', { get: () => useViewer.getState().settings });
  return viewer as Pick<ViewerEngine, 'loadModel' | 'applyModelCamera' | 'fit'> & {
    // Private orchestration entry point, also used by loadPreset/loadInitialModel.
    load: (name: string, loader: () => Promise<LoadedModel>, meta: CachedModel['meta'], restored?: CachedModel) => Promise<boolean>;
    restoreCamera: ReturnType<typeof vi.fn>;
  };
}

function model(count: number): LoadedModel {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  for (let i = 0; i < count; i++) {
    const camera = new THREE.PerspectiveCamera();
    camera.name = `View ${i + 1}`;
    root.add(camera);
  }
  return { name: 'Camera model', root, animations: [], revoke: vi.fn() };
}

beforeEach(() => {
  useViewer.setState({ settings: { ...DEFAULT_SETTINGS }, toast: null, cameras: [] });
});

describe('imported camera choice', () => {
  it.each(['perspective', 'orthographic'] as const)('continues orbiting a transformed %s scene camera without changing its view', async (projection) => {
    const viewer = engine();
    const data = model(0);
    const source = projection === 'perspective'
      ? new THREE.PerspectiveCamera(53, 4 / 3, 0.05, 250)
      : new THREE.OrthographicCamera(-3, 3, 2, -2, 0.05, 250);
    source.position.set(3, 2, 6);
    source.rotation.set(0.1, 0.4, 0.2);
    source.zoom = 1.25;
    source.updateProjectionMatrix();
    const parent = new THREE.Group();
    parent.position.set(1, 2, -1);
    parent.rotation.set(0.1, -0.3, 0.15);
    parent.scale.setScalar(2);
    parent.add(source);
    data.root.add(parent);
    await viewer.loadModel(data);
    const orbit = viewer as unknown as {
      beginOrbit(): void;
      applySettings(settings: Settings, previous: Settings): void;
      activeCamera(): THREE.PerspectiveCamera | THREE.OrthographicCamera;
      perspectiveCamera: THREE.PerspectiveCamera;
      controls: OrbitControls;
    };
    // OrbitControls supports updates without attaching DOM input listeners.
    const controls = new OrbitControls(orbit.perspectiveCamera);
    controls.enableDamping = true;
    orbit.controls = controls;
    Object.assign(viewer, { engine: { display: {} }, final: {}, preview: {}, focusQueryVersion: 0 });
    viewer.applyModelCamera(source.uuid);
    // Exercise the real settings path that previously disabled scene-camera input.
    controls.enabled = false;
    orbit.applySettings(useViewer.getState().settings, { ...useViewer.getState().settings, cameraIndex: -1 });
    expect(controls.enabled).toBe(true);
    controls.addEventListener('start', () => orbit.beginOrbit());
    source.updateWorldMatrix(true, false);
    const position = source.getWorldPosition(new THREE.Vector3());
    const quaternion = source.getWorldQuaternion(new THREE.Quaternion());
    const sourceMatrix = source.matrixWorld.clone();
    const unsubscribe = useViewer.subscribe((state, previous) => {
      if (state.settings !== previous.settings) orbit.applySettings(state.settings, previous.settings);
    });
    try { controls.dispatchEvent({ type: 'start' }); } finally { unsubscribe(); }
    const camera = orbit.activeCamera();
    expect(useViewer.getState().settings).toMatchObject({ cameraIndex: -1, projection });
    expect(camera).not.toBe(source);
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(Math.abs(camera.quaternion.dot(quaternion))).toBeCloseTo(1, 8);
    expect(camera.zoom).toBe(source.zoom);
    expect(camera.near).toBe(source.near);
    expect(camera.far).toBe(source.far);
    expect(controls.object).toBe(camera);
    expect(controls.enabled).toBe(true);
    expect(controls.enableDamping).toBe(true);
    if (camera instanceof THREE.PerspectiveCamera) expect(camera.fov).toBe(53);
    else expect(camera.top - camera.bottom).toBe(4);
    const rotation = camera.quaternion.clone();
    controls.autoRotate = true;
    controls.update(1 / 60);
    expect(Math.abs(camera.quaternion.dot(rotation))).toBeLessThan(1);
    source.updateWorldMatrix(true, false);
    expect(source.matrixWorld.equals(sourceMatrix)).toBe(true);
    // Re-selecting the scene camera restores its authored pose.
    viewer.applyModelCamera(source.uuid);
    expect(orbit.activeCamera()).toBe(source);
  });

  it('applies scene-tree cameras by identity and Fit returns to Orbit', async () => {
    const viewer = engine(), data = model(2);
    data.root.children[1].name = data.root.children[2].name = 'Duplicate';
    await viewer.loadModel(data);
    viewer.applyModelCamera(data.root.children[2].uuid);
    expect(useViewer.getState().settings.cameraIndex).toBe(1);
    expect(useViewer.getState().toast).toBeNull();
    viewer.applyModelCamera('missing');
    expect(useViewer.getState().settings.cameraIndex).toBe(1);
    viewer.fit();
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
  });

  it('uses imported lighting and falls back to the sky for an unlit replacement', async () => {
    const viewer = engine(), data = model(0);
    data.lighting = { available: true, environment: null, warnings: [] };
    await viewer.loadModel(data);
    expect(useViewer.getState().settings).toMatchObject({ envId: 'model', envIntensity: 1, lighting: 'environment' });
    await viewer.loadModel(model(0));
    expect(useViewer.getState().settings.envId).toBe('sky');
  });

  it('rejects stale scene-lighting settings when the current model has no lights', async () => {
    const viewer = engine();
    await viewer.loadModel(model(0));
    setSettings({ envId: 'model', envIntensity: 0, envRotation: 70 });
    const settings = useViewer.getState().settings;
    (viewer as unknown as { applySettings(s: Settings, previous: Settings): void }).applySettings(settings, settings);
    expect(useViewer.getState().settings).toMatchObject({ envId: 'sky', envIntensity: 1, envRotation: 0 });
  });
  it('offers only Apply camera while retaining all cameras for manual selection', async () => {
    const viewer = engine();
    await viewer.loadModel(model(2));
    expect(useViewer.getState().cameras).toEqual(['View 1', 'View 2']);
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    const toast = useViewer.getState().toast!;
    expect(toast.message).toContain('2 cameras');
    expect(toast.actions?.map((action) => action.label)).toEqual(['Apply camera']);
    setSettings({ cameraIndex: 1 });
    expect(useViewer.getState().settings.cameraIndex).toBe(1);
    toast.actions![0].onClick();
    expect(useViewer.getState().settings.cameraIndex).toBe(0);
  });

  it('starts replacement models in Orbit even when the previous camera index exists', async () => {
    const viewer = engine();
    await viewer.loadModel(model(2));
    const oldApply = useViewer.getState().toast!.actions![0].onClick;
    setSettings({ cameraIndex: 1 });
    await viewer.loadModel(model(2));
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    oldApply();
    expect(useViewer.getState().settings.cameraIndex).toBe(-1);
    await viewer.loadModel(model(0));
    expect(useViewer.getState().cameras).toEqual([]);
    expect(useViewer.getState().toast).toBeNull();
  });

  it.each([false, true])('prompts on initial/cached loads only if no camera was restored (%s)', async (restored) => {
    const viewer = engine();
    viewer.restoreCamera.mockImplementation(() => {
      if (restored) setSettings({ cameraIndex: 1 });
      return restored;
    });
    const data = model(2);
    const cached: CachedModel = {
      id: 'preset:research-test', meta: { name: data.name, presetId: 'research-test', credit: null, sourceUrl: null }
    };
    await viewer.load(data.name, async () => data, cached.meta, cached);
    expect(viewer.restoreCamera).toHaveBeenCalledWith(cached.id);
    expect(useViewer.getState().settings.cameraIndex).toBe(restored ? 1 : -1);
    expect(useViewer.getState().toast !== null).toBe(!restored);
  });
});
