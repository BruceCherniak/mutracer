import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import type { OutputChunk, RollupOutput } from 'rollup';
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
      console, location: 'https://example.test/mutracer.umd.js'
    });
    context.self = context;
    runInContext(chunks.find(chunk => chunk.fileName === 'mutracer.umd.js')!.code, context);
    api = context.MuTracer;
  }, 20_000);

  it('ships only the CDN global build, without duplicate ESM or OIDN chunks', () => {
    expect(chunks.map(chunk => chunk.fileName)).toEqual(['mutracer.umd.js']);
  });

  it('excludes the tessellator implementation and its public helper', () => {
    for (const chunk of chunks) {
      expect(Object.keys(chunk.modules).some(id => id.endsWith('/util/tessellateDisplacement.ts'))).toBe(false);
    }
    expect('buildOpenSubdivAdaptiveFaceLevels' in api).toBe(false);
  });

  it('builds ordinary and projective BVHs but rejects tessellation', async () => {
    const material = new api.OpenPBRMaterial();
    const mesh = new api.Mesh(api.createPlaneGeometry(), material);
    async function precomputeMesh() {
      const prepared = api.prepareForPrecompute([mesh]);
      return api.precompute(
        prepared.geometries, prepared.displacementScales,
        prepared.trianglesDisplacements, undefined, prepared.tessellations,
        undefined, prepared.projectiveDisplacements
      );
    }
    expect((await precomputeMesh()).geometries[0].bvh!.buffer.byteLength).toBeGreaterThan(0);
    material.displacementMap = new api.Texture({
      data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1
    });
    expect((await precomputeMesh()).geometries[0].bvh!.buffer.byteLength).toBeGreaterThan(0);
    material.displacementMode = 'tessellated';
    await expect(precomputeMesh()).rejects.toThrow('Displacement tessellation is not available');
  });
});
