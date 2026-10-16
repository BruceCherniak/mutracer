/// <reference lib="dom" />
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenPBRMaterial, Texture } from '@meimu/mutracer';

vi.hoisted(() => { vi.stubGlobal('location', { hash: '', href: 'https://viewer.example.com/' }); });
vi.mock('../src/engine/modelCache', () => ({ readMaterialEdits: vi.fn(), saveMaterialEdits: vi.fn() }));
import { MaterialEditor, readPendingEdits } from '../src/engine/materialEditor';
import { readMaterialEdits, saveMaterialEdits } from '../src/engine/modelCache';
import { discardHistory, redo, undo } from '../src/history';

class Bitmap {}
let editor: MaterialEditor;

function setup(hasUVs = true) {
  const source = new THREE.MeshStandardMaterial();
  source.name = 'Surface';
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source);
  const material = new OpenPBRMaterial();
  editor = new MaterialEditor(() => {});
  editor.setModel(mesh, null);
  editor.onConverted(source, material, mesh.uuid, hasUVs);
  return { source, mesh, material };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ImageBitmap', Bitmap);
  vi.stubGlobal('HTMLImageElement', class {});
  vi.stubGlobal('HTMLCanvasElement', class {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => new Bitmap()));
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,thumb' }) });
});
afterEach(() => {
  editor?.setModel(null, null);
  discardHistory('material');
  vi.unstubAllGlobals();
});

describe('viewer displacement edits', () => {
  it('uploads a linear height texture with the existing UV transform and supports undo, redo and reset', async () => {
    const { source, material } = setup();
    material.map = new Texture({ data: new Uint8Array(4), width: 1, height: 1 });
    material.map.uvScale = [2, 3]; material.map.uvOffset = [.1, .2]; material.map.uvChannel = 1;
    const file = new Blob(['height'], { type: 'image/png' });
    await editor.setTextures(source.uuid, { displacementMap: file }, { displacementScale: .04, displacementBias: -.02, displacementStepSize: .005 }, 'Height');
    const height = material.displacementMap!;
    expect(height.uvScale).toEqual([2, 3]);
    expect(height.uvOffset).toEqual([.1, .2]);
    expect(height.uvChannel).toBe(1);
    expect(createImageBitmap).toHaveBeenCalledWith(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    expect(editor.describe(source.uuid)?.maps.displacementMap).toContain('data:image/png');
    undo();
    expect(material.displacementMap).toBeUndefined();
    expect(material.displacementScale).toBe(.1);
    expect(material.displacementBias).toBe(0);
    redo();
    expect(material.displacementMap).toBe(height);
    expect(material.displacementBias).toBe(-.02);
    expect(material.displacementStepSize).toBe(.005);
    editor.reset(source.uuid);
    expect(material.displacementMap).toBeUndefined();
    expect(material.displacementScale).toBe(.1);
    expect(material.displacementBias).toBe(0);
  });

  it('selects triplanar coordinates for a UV-less mesh in the same undo step', async () => {
    const { source, material } = setup(false);
    await editor.setTexture(source.uuid, 'displacementMap', new Blob(['height']), 'Height');
    expect(material.displacementUvProjection).toBe('triplanar');
    undo();
    expect(material.displacementMap).toBeUndefined();
    expect(material.displacementUvProjection).toBe('none');
    redo();
    expect(material.displacementUvProjection).toBe('triplanar');
  });

  it('persists the height file and settings and restores them on reload', async () => {
    const { source, mesh, material } = setup();
    editor.modelId = 'model';
    const file = new Blob(['height'], { type: 'image/jpeg' });
    await editor.setTextures(source.uuid, { displacementMap: file }, {
      displacementScale: .025, displacementBias: -.0125, displacementStepSize: .003, displacementUvProjection: 'spherical', displacementUvProjectionScale: 2
    }, 'Height');
    editor.flush();
    const saved = vi.mocked(saveMaterialEdits).mock.calls[0][0];
    expect(saved.materials[0].textures).toEqual([{ slot: 'displacementMap', file }]);
    vi.mocked(readMaterialEdits).mockResolvedValue(saved);
    const pending = await readPendingEdits('model');
    editor.setModel(mesh, pending);
    const restored = new OpenPBRMaterial();
    editor.onConverted(source, restored, mesh.uuid);
    expect(restored.displacementMap).toBeDefined();
    expect(restored.displacementMap).not.toBe(material.displacementMap);
    expect(restored.displacementScale).toBe(.025);
    expect(restored.displacementBias).toBe(-.0125);
    expect(restored.displacementStepSize).toBe(.003);
    expect(restored.displacementUvProjection).toBe('spherical');
    expect(restored.displacementUvProjectionScale).toBe(2);
    await editor.setTexture(source.uuid, 'displacementMap', null, 'Remove height');
    expect(restored.displacementMap).toBeUndefined();
    undo();
    expect(restored.displacementMap).toBeDefined();
  });
});
