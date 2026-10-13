import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build } from 'vite';
import type { OutputAsset, OutputChunk } from 'rollup';
import * as library from '../../src/main';

let main: OutputChunk, worker: OutputAsset, wasm: OutputAsset, runtime: OutputAsset;
const directory = mkdtempSync(path.join(tmpdir(), 'mutracer-standalone-test-'));

beforeAll(async () => {
  const result = await build({
    configFile: path.resolve('vite.config.ts'), logLevel: 'silent',
    build: { write: false }
  });
  if ('on' in result) throw new Error('Unexpected watch build');
  const output = (Array.isArray(result) ? result[0] : result).output;
  main = output.find(item => item.type === 'chunk' && item.isEntry) as OutputChunk;
  const assets = output.filter((item): item is OutputAsset => item.type === 'asset');
  const wasmAssets = assets.filter(item => item.fileName.endsWith('.wasm'));
  expect(wasmAssets).toHaveLength(1);
  wasm = wasmAssets[0];
  worker = assets.find(item => item.fileName === 'assets/bvh.worker.js')!;
  runtime = assets.find(item => item.fileName === 'assets/oidn-runtime.js')!;
  expect(main).toBeDefined(); expect(worker).toBeDefined(); expect(runtime).toBeDefined();
}, 30_000);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('keeps the UMD exports and does not load optional assets at module evaluation', () => {
  const fetch = vi.fn();
  const context = {
    URL, fetch,
    document: { currentScript: { src: 'https://cdn.example/package/dist/mutracer.umd.js' }, baseURI: 'https://app.example/' },
    MuTracer: undefined as typeof library | undefined
  };
  runInNewContext(main.code, context);
  expect(Object.keys(context.MuTracer!).sort()).toEqual(Object.keys(library).sort());
  expect(typeof context.MuTracer!.Engine).toBe('function');
  expect(fetch).not.toHaveBeenCalled();
  expect(main.dynamicImports).toEqual([runtime.fileName]);
  expect(Object.keys(main.modules).some(id => /oidn-web|float16|oidnNetwork/.test(id))).toBe(false);
});

it('emits the exact original WASM bytes without Base64 copies in either script', () => {
  expect(Buffer.from(wasm.source)).toEqual(readFileSync('src/tinybvh/tinybvh.wasm'));
  expect(wasm.fileName).toBe('assets/tinybvh.wasm');
  const encoded = Buffer.from(wasm.source).toString('base64');
  expect(main.code).not.toContain(encoded);
  expect(String(worker.source)).not.toContain(encoded);
});

it('loads the same binary relative to the library script on the calling thread', async () => {
  const requested: string[] = [];
  const context = {
    URL, performance, console,
    document: { currentScript: { src: 'https://cdn.example/package/dist/mutracer.umd.js?v=1' }, baseURI: 'https://app.example/' },
    fetch: async (url: string | URL) => {
      requested.push(String(url));
      return new Response(wasm.source);
    },
    MuTracer: undefined as typeof library | undefined
  };
  runInNewContext(main.code, context);
  const { Engine, Mesh, OpenPBRMaterial, createCubeGeometry } = context.MuTracer!;
  const engine = new Engine({ canvas: {width: 1, height: 1} as HTMLCanvasElement });
  engine.bvhBuilder = 'tinybvh';
  try {
    await engine.prepare({ meshes: [new Mesh(createCubeGeometry(), new OpenPBRMaterial())], lights: [] });
    expect(requested).toEqual([`https://cdn.example/package/dist/${wasm.fileName}`]);
    expect(engine.getDiagnostics()?.bvh?.lastBuild?.geometryCount).toBe(1);
  } finally { engine.dispose(); }
});

it('loads the shared binary relative to the worker and builds a real TinyBVH', async () => {
  const requested: string[] = [];
  let finish!: (response: any) => void;
  const response = new Promise<any>(resolve => { finish = resolve; });
  const self = {
    location: { href: `https://cdn.example/package/dist/${worker.fileName}` },
    postMessage: finish,
    onmessage: undefined as ((event: { data: object }) => void) | undefined
  };
  runInNewContext(String(worker.source), {
    self, URL, WebAssembly, performance, console,
    fetch: async (url: string | URL) => {
      requested.push(String(url));
      return new Response(wasm.source);
    }
  });
  expect(requested).toEqual([]);
  self.onmessage!({ data: {
    id: 7, builder: 'tinybvh', layout: 'bvh2', dynamic: false,
    displacementScale: 0, spatialSplits: false,
    position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), itemSize: 3 },
    indices: { array: new Uint32Array([0, 1, 2]), itemSize: 1 }
  } });
  const built = await response;
  expect(built.error).toBeUndefined();
  expect(built.id).toBe(7);
  expect(built.bvh.builder).toBe('tinybvh');
  expect(built.bvh.buffer.byteLength).toBeGreaterThan(0);
  expect(requested).toEqual([`https://cdn.example/package/dist/${wasm.fileName}`]);
}, 10_000);

it('loads the OIDN runtime as a self-contained module with its original backend guard', async () => {
  const filename = path.join(directory, 'oidn-runtime.mjs');
  writeFileSync(filename, runtime.source);
  // Import directly in Node, without Vitest's source-module transforms.
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const network = await import(process.argv[1]);
    assert.deepEqual(Object.keys(network), ['loadOIDNNetwork']);
    let initialized = 0;
    await assert.rejects(network.loadOIDNNetwork({
      init: async () => { initialized++; }, backend: 'webgl'
    }, {type: 'oidn'}), /OIDN requires a WebGPU engine/);
    assert.equal(initialized, 1);
  `, pathToFileURL(filename).href]);
});
