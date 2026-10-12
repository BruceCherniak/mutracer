/// <reference lib="dom" />
import { File } from 'node:buffer';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModelFromFiles, loadModelFromSource, loadModelFromURL } from '../src/engine/loadModel';

const nativeFetch = globalThis.fetch;
const vertices = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const json = {
  asset: { version: '2.0' }, buffers: [{ uri: 'mesh.bin', byteLength: vertices.byteLength }],
  bufferViews: [{ buffer: 0, byteLength: vertices.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  images: [{ uri: 'textures/base.png' }], textures: [{ source: 0 }],
  materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
  nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0
};

function imageBytes(mesh: THREE.Mesh) {
  return ((mesh.material as THREE.MeshStandardMaterial).map?.image as { bytes: string } | undefined)?.bytes;
}

describe('viewer cached model loading', () => {
  beforeEach(() => {
    vi.stubGlobal('File', File);
    vi.stubGlobal('location', { href: 'https://viewer.example.com/' });
    vi.stubGlobal('self', { URL });
    vi.stubGlobal('ProgressEvent', class { constructor(public type: string, public init: unknown) {} });
    vi.stubGlobal('createImageBitmap', vi.fn(async (blob: Blob) => ({ width: 1, height: 1, bytes: await blob.text(), close() {} })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function network(main: string | ArrayBuffer) {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, options?: RequestInit) => {
      const address = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
      if (address.startsWith('blob:')) return nativeFetch(request, options);
      requests.push(address);
      if (address.endsWith('mesh.bin')) return new Response(vertices.buffer);
      if (address.endsWith('base.png')) return new Response('texture pixels');
      return new Response(main);
    }));
    return requests;
  }

  it.each(['gltf', 'glb'])('downloads %s dependencies once and restores geometry and textures without network', async (extension) => {
    let main: string | ArrayBuffer = JSON.stringify(json);
    if (extension === 'glb') {
      const text = new TextEncoder().encode(main);
      const length = Math.ceil(text.length / 4) * 4;
      main = new ArrayBuffer(20 + length);
      const view = new DataView(main);
      view.setUint32(0, 0x46546c67, true);
      view.setUint32(4, 2, true);
      view.setUint32(8, main.byteLength, true);
      view.setUint32(12, length, true);
      view.setUint32(16, 0x4e4f534a, true);
      new Uint8Array(main, 20).fill(32);
      new Uint8Array(main, 20).set(text);
    }
    const requests = network(main);
    const loaded = await loadModelFromURL(`https://example.com/models/scene.${extension}`, vi.fn());
    expect(requests).toHaveLength(3);
    expect(loaded.source?.files).toHaveLength(3);
    const mesh = loaded.root.children[0] as THREE.Mesh;
    expect(Array.from(mesh.geometry.getAttribute('position').array)).toEqual(Array.from(vertices));
    expect(imageBytes(mesh)).toBe('texture pixels');

    loaded.revoke();
    requests.length = 0;
    const restored = await loadModelFromSource(loaded.source!, vi.fn());
    expect(requests).toEqual([]);
    const restoredMesh = restored.root.children[0] as THREE.Mesh;
    expect(Array.from(restoredMesh.geometry.getAttribute('position').array)).toEqual(Array.from(vertices));
    expect(imageBytes(restoredMesh)).toBe('texture pixels');
    restored.revoke();
  });

  it('preserves dropped folder paths and resolves nested texture files', async () => {
    const requests = network('unexpected network');
    const files = [
      { path: 'folder/scene.gltf', file: new File([JSON.stringify(json)], 'scene.gltf') },
      { path: 'folder/mesh.bin', file: new File([new Uint8Array(vertices.buffer)], 'mesh.bin') },
      { path: 'folder/textures/base.png', file: new File(['local pixels'], 'base.png') }
    ] as unknown as Parameters<typeof loadModelFromFiles>[0];
    const model = await loadModelFromFiles(files, vi.fn());
    expect(model.source?.files.map(({ path }) => path)).toEqual(files.map(({ path }) => path));
    expect(requests).toEqual([]);
    expect(imageBytes(model.root.children[0] as THREE.Mesh)).toBe('local pixels');
    model.revoke();
  });

  it('releases dependency blob URLs when parsing fails', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const files = [
      { path: 'bad.gltf', file: new File(['invalid'], 'bad.gltf') },
      { path: 'mesh.bin', file: new File([new Uint8Array(vertices.buffer)], 'mesh.bin') }
    ] as unknown as Parameters<typeof loadModelFromFiles>[0];
    await expect(loadModelFromFiles(files, vi.fn())).rejects.toThrow();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
