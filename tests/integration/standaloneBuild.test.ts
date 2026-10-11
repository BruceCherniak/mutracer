import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import type { OutputChunk, RollupOutput } from 'rollup';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import { beforeAll, describe, expect, it } from 'vitest';

type API = typeof import('../../src/main');

describe('standalone library builds', () => {
  let chunks: OutputChunk[];
  let api: API;

  beforeAll(async () => {
    const outputs = await build({
      configFile: fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
      logLevel: 'silent',
      build: { write: false }
    }) as RollupOutput[];
    chunks = outputs.flatMap(output => output.output)
      .filter((output): output is OutputChunk => output.type === 'chunk');
    const context = createContext({
      URL, Float32Array, Uint32Array, Uint8Array, Int32Array, Uint16Array,
      performance, console, location: 'https://example.test/mutracer.umd.js'
    });
    context.self = context;
    runInContext(chunks.find(chunk => chunk.fileName === 'mutracer.umd.js')!.code, context);
    api = context.MuTracer;
  }, 20_000);

  it('ships only the CDN global build, without duplicate ESM or OIDN chunks', () => {
    expect(chunks.map(chunk => chunk.fileName)).toEqual(['mutracer.umd.js']);
  });


  it('loads its Worker relative to the library script after script evaluation completes', async () => {
    let workerUrl: string | undefined;
    const document = { currentScript: { src: 'https://cdn.example.test/package/dist/mutracer.umd.js' },
      baseURI: 'https://app.example.test/viewer/' };
    class Worker {
      onmessage?: (event: { data: unknown }) => void;
      constructor(url: URL) { workerUrl = url.href; }
      postMessage(data: { id: number; position: any; indices: any }) {
        const bvh = buildBLAS(data as any);
        queueMicrotask(() => this.onmessage?.({ data: { id: data.id, bvh } }));
      }
    }
    const context = createContext({ URL, Worker, document, console,
      Float32Array, Uint32Array, Uint8Array, Int32Array, Uint16Array });
    context.self = context;
    runInContext(chunks.find(chunk => chunk.fileName === 'mutracer.umd.js')!.code, context);
    document.currentScript = null as any;
    const library = context.MuTracer as API;
    const renderer = new library.Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    const geometry = library.createCubeGeometry();
    await renderer.prepareScene([new library.Mesh(geometry, new library.OpenPBRMaterial())]);
    expect(workerUrl).toMatch(/^https:\/\/cdn\.example\.test\/package\/dist\/assets\/bvh\.worker-.+\.js$/);
    expect(geometry.bvh!.buffer.byteLength).toBeGreaterThan(0);
  });

  it('builds ordinary and projective BVHs', async () => {
    const material = new api.OpenPBRMaterial();
    const mesh = new api.Mesh(api.createPlaneGeometry(), material);
    const renderer = new api.Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    expect((await renderer.prepareScene([mesh])).geometryCount).toBe(1);
    expect(mesh.geometry.bvh!.buffer.byteLength).toBeGreaterThan(0);
    material.displacementMap = new api.Texture({
      data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1
    });
    material.displacementScale = 0.1;
    material.displacementUvProjection = 'triplanar';
    expect((await renderer.prepareScene([mesh], {rebuild: true})).geometryCount).toBe(1);
  });
});
