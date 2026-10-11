/// <reference lib="dom" />
import * as THREE from 'three';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import type { MaterialEdits } from '../../viewer/src/engine/modelCache';
import type * as EditorModule from '../../viewer/src/engine/materialEditor';
import type * as StoreModule from '../../viewer/src/store';
import type * as HistoryModule from '../../viewer/src/history';

const storage = vi.hoisted(() => ({ edits: null as MaterialEdits | null }));
vi.mock('../../viewer/src/engine/modelCache', () => ({
  readMaterialEdits: async () => storage.edits,
  saveMaterialEdits: async (edits: MaterialEdits) => { storage.edits = edits.materials.length ? edits : null; }
}));
vi.mock('@meimu/mutracer', async () => ({
  DEFAULT_JNLM_OPTIONS: (await import('../../src/renderer/jnlm')).DEFAULT_JNLM_OPTIONS,
  Texture: (await import('../../src/scene/Texture')).default
}));

class FakeBitmap { constructor(readonly source: Blob) {} }

let MaterialEditor: typeof EditorModule.MaterialEditor;
let readPendingEdits: typeof EditorModule.readPendingEdits;
let useViewer: typeof StoreModule.useViewer;
let setSettings: typeof StoreModule.setSettings;
let history: typeof HistoryModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  vi.stubGlobal('location', { hash: '' });
  vi.stubGlobal('ImageBitmap', FakeBitmap);
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => new FakeBitmap(blob));
  ({ MaterialEditor, readPendingEdits } = await import('../../viewer/src/engine/materialEditor'));
  ({ useViewer, setSettings } = await import('../../viewer/src/store'));
  history = await import('../../viewer/src/history');
});
afterAll(() => { vi.unstubAllGlobals(); });

/** A model with two materials and the converted material of each. */
function model() {
  const first = new THREE.MeshStandardMaterial({ name: 'Paint' });
  const second = new THREE.MeshStandardMaterial({ name: 'Rubber' });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BufferGeometry(), first), new THREE.Mesh(new THREE.BufferGeometry(), second));
  const converted = [new OpenPBRMaterial(), new OpenPBRMaterial()];
  converted[1].specularRoughness = 0.5;
  converted[1].map = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
  return { root, sources: [first, second], converted };
}

function open(editor: EditorModule.MaterialEditor, scene: ReturnType<typeof model>, pending: EditorModule.PendingEdits | null = null) {
  editor.setModel(scene.root, pending);
  editor.modelId = 'model';
  scene.sources.forEach((source, i) => editor.onConverted(source, scene.converted[i], `mesh-${i}`));
}

describe('viewer material editor and undo history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    storage.edits = null;
    history.discardHistory('material');
    history.discardHistory('settings');
    useViewer.setState({ material: null });
  });

  it('collapses a slider drag into one undo step and replays values and textures', async () => {
    const editor = new MaterialEditor(() => {});
    const scene = model();
    open(editor, scene);
    const id = scene.sources[1].uuid;
    const original = scene.converted[1].map;
    editor.setValues(id, { specularRoughness: 0.6 }, 'Roughness', 'roughness');
    editor.setValues(id, { specularRoughness: 0.7 }, 'Roughness', 'roughness');
    await editor.setTexture(id, 'map', null, 'Remove base color texture');
    expect(useViewer.getState().history).toEqual({ undo: 'Remove base color texture', redo: null });

    history.undo();
    expect(scene.converted[1].map).toBe(original);
    history.undo();
    expect(scene.converted[1].specularRoughness).toBe(0.5);
    expect(useViewer.getState().history).toEqual({ undo: null, redo: 'Roughness' });
    history.redo();
    expect(scene.converted[1].specularRoughness).toBe(0.7);

    // A new edit discards the redo branch.
    editor.setValues(id, { baseMetalness: 1 }, 'Metalness');
    expect(useViewer.getState().history).toEqual({ undo: 'Metalness', redo: null });
  });

  it('restores saved values and uploaded textures onto the reloaded model', async () => {
    const editor = new MaterialEditor(() => {});
    const scene = model();
    open(editor, scene);
    const upload = new Blob(['png'], { type: 'image/png' });
    editor.setValues(scene.sources[0].uuid, { baseColor: [0.2, 0.3, 0.4] }, 'Color');
    await editor.setTexture(scene.sources[0].uuid, 'normalMap', upload, 'Normal texture');
    await editor.setTexture(scene.sources[1].uuid, 'map', null, 'Remove base color texture');
    await vi.runAllTimersAsync();
    expect(storage.edits?.materials.map((m) => [m.index, m.name])).toEqual([[0, 'Paint'], [1, 'Rubber']]);

    // Edits belong to one model.
    expect(await readPendingEdits('other')).toBeNull();
    // A reload converts fresh materials; the stored edits apply on conversion.
    const reloaded = model();
    const pending = await readPendingEdits('model');
    open(editor, reloaded, pending);
    expect(reloaded.converted[0].baseColor).toEqual([0.2, 0.3, 0.4]);
    expect((reloaded.converted[0].normalMap?.image as unknown as FakeBitmap).source).toBe(upload);
    expect(reloaded.converted[1].map).toBeUndefined();
    expect(reloaded.converted[1].specularRoughness).toBe(0.5);
    expect(useViewer.getState().history).toEqual({ undo: null, redo: null });

    // Resetting the edits removes them from storage.
    editor.reset(reloaded.sources[0].uuid);
    editor.reset(reloaded.sources[1].uuid);
    await vi.runAllTimersAsync();
    expect(storage.edits).toBeNull();
  });

  it('shares one history between lighting, render and material edits', () => {
    const editor = new MaterialEditor(() => {});
    const scene = model();
    open(editor, scene);
    const start = useViewer.getState().settings;
    setSettings({ envIntensity: 1.5 });
    setSettings({ envIntensity: 2 }); // A slider drag is one step.
    editor.setValues(scene.sources[0].uuid, { baseMetalness: 1 }, 'Metalness');
    setSettings({ toneMapping: 'aces' });
    setSettings({ fov: 50 }); // Camera settings follow the view and are not recorded.
    expect(useViewer.getState().history).toEqual({ undo: 'Tone mapping', redo: null });

    history.undo();
    expect(useViewer.getState().settings.toneMapping).toBe(start.toneMapping);
    expect(useViewer.getState().settings.fov).toBe(50);
    history.undo();
    expect(scene.converted[0].baseMetalness).toBe(0);
    history.redo();
    expect(scene.converted[0].baseMetalness).toBe(1);

    // Opening a model drops its material steps and keeps the settings steps.
    open(editor, model());
    expect(useViewer.getState().history).toEqual({ undo: 'Environment intensity', redo: 'Tone mapping' });
    history.undo();
    expect(useViewer.getState().settings.envIntensity).toBe(start.envIntensity);
    expect(useViewer.getState().history).toEqual({ undo: null, redo: 'Environment intensity' });
  });

  it('drops a merged step that ends where it started and skips uploaded environments', () => {
    const start = useViewer.getState().settings.exposure;
    setSettings({ exposure: start + 1 });
    setSettings({ exposure: start });
    expect(useViewer.getState().history).toEqual({ undo: null, redo: null });

    useViewer.setState((s) => ({ settings: { ...s.settings, envId: 'custom' } }));
    setSettings({ envId: 'sky' });
    expect(useViewer.getState().history.undo).toBeNull();
  });
});
