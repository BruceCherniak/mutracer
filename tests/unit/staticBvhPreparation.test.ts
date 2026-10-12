import { prebuildStats } from '../helpers/prebuildStats';
import { getGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { afterEach, expect, it, vi } from 'vitest';
import Renderer from '../../src/Renderer';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import { createCubeGeometry, createSphereGeometry } from '../../src/util/commonGeometry';
import { getPreparedMeshGeometry, updateMeshInstances } from '../../src/renderer/prepareMeshBVH';
import { prepareStaticBvhs } from '../../src/renderer/staticBvhPreparation';
import * as worker from '../../src/renderer/bvhWorkerClient';
import { executeBvhBuild } from '../../src/renderer/bvhWorkerBuild';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import { buildTinyBvh } from '../../src/tinybvh/TinyBvhBuilder';

vi.mock('../../src/tinybvh/TinyBvhBuilder', () => ({
  buildTinyBvh: vi.fn(async (geometry, scale, displacement, layout) => ({
    ...buildBLAS(geometry, scale, displacement), builder: 'tinybvh', layout, bvhTimeMs: 2
  }))
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(buildTinyBvh).mockClear(); });
function renderer() { return new Renderer({canvas: {width: 1, height: 1} as HTMLCanvasElement}); }
function mesh() { return new Mesh(createCubeGeometry(), new OpenPBRMaterial()); }
function simulatedWorker() {
  vi.stubGlobal('Worker', class {});
  return vi.spyOn(worker, 'buildBvhInWorker').mockImplementation(async (
    geometry, displacementScale = 0, trianglesDisplacement, builder = 'builtin', layout = 'bvh2', spatialSplits = false
  ) => executeBvhBuild(structuredClone({id: 0, position: geometry.position, normal: geometry.normal,
    indices: geometry.indices, dynamic: geometry.dynamic, displacementScale, trianglesDisplacement, builder, layout, spatialSplits})));
}

it.each(['ordinary', 'none', 'triplanar'] as const)('matches synchronous BVH bytes for %s geometry', async projection => {
  simulatedWorker();
  const makeMesh = () => {
    const material = new OpenPBRMaterial();
    if (projection !== 'ordinary') {
      material.displacementMap = new Texture({data: Uint8Array.from({length: 64}, (_, i) => i * 4), width: 4, height: 4});
      material.displacementScale = 0.1;
      material.displacementUvProjection = projection;
    }
    const sphere = createSphereGeometry(12, 6);
    const geometry = new Geometry({position: sphere.position, indices: sphere.indices, uv: sphere.uv});
    return new Mesh(geometry, material);
  };
  const asynchronous = makeMesh(), synchronous = makeMesh();
  const positions = asynchronous.geometry.position.array.slice();
  await prebuildStats(renderer(), [asynchronous]);
  updateMeshInstances([synchronous]);
  const target = getPreparedMeshGeometry(asynchronous);
  expect(new Uint8Array(getGeometryBvh(target)!.buffer)).toEqual(new Uint8Array(getGeometryBvh(getPreparedMeshGeometry(synchronous))!.buffer));
  expect(asynchronous.geometry.position.array).toEqual(positions);
  if (projection === 'triplanar') expect(target).not.toBe(asynchronous.geometry);
});

it('isolates invalid UV displacement without disabling Workers or retrying each frame', async () => {
  const build = simulatedWorker();
  const bad = mesh(), good = mesh();
  bad.geometry.uv = undefined;
  bad.materials[0].displacementMap = new Texture({data: new Uint8Array(64), width: 4, height: 4});
  bad.materials[0].displacementScale = 0.1;
  const r = renderer();
  await prebuildStats(r, [bad, good]);
  expect(getGeometryBvh(good.geometry)?.builder).toBe('builtin');
  expect(getGeometryBvh(bad.geometry)).toBeUndefined();
  expect(build).toHaveBeenCalledOnce();
  expect((r as any)._bvhWorkerUnavailable).toBe(false);
  expect((r as any)._needsBVHPreparation([bad])).toBe(false);
  expect(() => updateMeshInstances([bad])).toThrow('UV');
});

it('retries TinyBVH on the main thread when the Worker is unavailable', async () => {
  vi.stubGlobal('Worker', class {});
  vi.spyOn(worker, 'buildBvhInWorker').mockRejectedValue(new worker.BvhWorkerUnavailableError('worker failed'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const r = renderer(); r.bvhBuilder = 'tinybvh';
  const first = mesh(); await prebuildStats(r, [first]);
  expect(getGeometryBvh(first.geometry)?.builder).toBe('tinybvh');
  expect(buildTinyBvh).toHaveBeenCalledOnce();
  expect((r as any)._bvhWorkerUnavailable).toBe(true);
  expect((r as any)._tinyBvhUnavailable).toBe(false);
  await prebuildStats(r, [mesh()]);
  expect(warning).toHaveBeenCalledOnce();
});

it('retries TinyBVH failures with builtin in the same Worker and warns once', async () => {
  const build = simulatedWorker();
  build.mockImplementation(async (geometry, scale, displacement, builder) => {
    if (builder === 'tinybvh') throw new Error('TinyBVH failed');
    return buildBLAS(geometry, scale, displacement);
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const r = renderer(); r.bvhBuilder = 'tinybvh';
  const first = mesh(); await prebuildStats(r, [first]);
  expect(getGeometryBvh(first.geometry)?.builder).toBe('builtin');
  expect(build.mock.calls.map(c => c[3])).toEqual(['tinybvh', 'builtin']);
  expect((r as any)._tinyBvhUnavailable).toBe(true);
  expect((r as any)._bvhWorkerUnavailable).toBe(false);
  await prebuildStats(r, [mesh()]);
  expect(warning).toHaveBeenCalledOnce();
});

it('serializes concurrent calls and builds shared geometry once', async () => {
  const build = simulatedWorker();
  const shared = createCubeGeometry();
  const a = new Mesh(shared, new OpenPBRMaterial()), b = new Mesh(shared, new OpenPBRMaterial()), c = mesh();
  const r = renderer();
  await Promise.all([prebuildStats(r, [a, b]), prebuildStats(r, [a, b, c])]);
  expect(build).toHaveBeenCalledTimes(2);
  expect(getGeometryBvh(shared)).toBeDefined(); expect(getGeometryBvh(c.geometry)).toBeDefined();
});

it('does not mark builtin build errors as Worker failures', async () => {
  simulatedWorker().mockRejectedValue(new Error('invalid geometry'));
  const r = renderer(), bad = mesh();
  await prebuildStats(r, [bad]);
  expect((r as any)._bvhWorkerUnavailable).toBe(false);
  expect((r as any)._needsBVHPreparation([bad])).toBe(false);
});

it('retains the old BLAS while rebuilding and after a failed replacement', async () => {
  const build = simulatedWorker();
  const m = mesh(); updateMeshInstances([m]); const old = getGeometryBvh(m.geometry);
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  build.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const options = {builder: 'builtin' as const, layout: 'bvh2' as const, spatialSplits: false, useWorker: true, rebuild: true};
  const pending = prepareStaticBvhs([m], options);
  expect(getGeometryBvh(m.geometry)).toBe(old);
  finish(buildBLAS(m.geometry)); await pending;
  expect(getGeometryBvh(m.geometry)).not.toBe(old);
  const replacement = getGeometryBvh(m.geometry);
  build.mockRejectedValueOnce(new Error('failed rebuild'));
  const failed = await prepareStaticBvhs([m], options);
  expect(failed.failedMeshes).toEqual([m]); expect(getGeometryBvh(m.geometry)).toBe(replacement);
});

it('ignores empty and dynamic geometry during static preparation', async () => {
  const build = simulatedWorker();
  const dynamic = mesh(); dynamic.geometry.dynamic = true;
  const empty = new Mesh(new Geometry({position: new Attribute(new Float32Array(0), 3)}), new OpenPBRMaterial());
  await prebuildStats(renderer(), [dynamic, empty]);
  expect(build).not.toHaveBeenCalled();
  expect(getGeometryBvh(dynamic.geometry)).toBeUndefined();
});
