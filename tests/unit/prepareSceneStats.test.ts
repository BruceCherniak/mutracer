import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Renderer, type PrepareSceneOptions, type PrepareSceneResult, type TinyBvhLayout } from '../../src/main';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import { buildTinyBvh } from '../../src/tinybvh/TinyBvhBuilder';
import * as worker from '../../src/renderer/bvhWorkerClient';

vi.mock('../../src/tinybvh/TinyBvhBuilder.js', () => ({
  buildTinyBvh: vi.fn(async (geometry, scale, displacement, layout) => ({
    ...buildBLAS(geometry, scale, displacement), builder: 'tinybvh', layout, bvhTimeMs: 2
  }))
}));
beforeEach(() => { vi.mocked(buildTinyBvh).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function renderer() { return new Renderer({canvas: {width: 1, height: 1} as HTMLCanvasElement}); }
function mesh() { return new Mesh(createCubeGeometry(), new OpenPBRMaterial()); }

it('counts shared static geometry once, reports builder time and skips cached BLASes', async () => {
  const shared = createCubeGeometry(), r = renderer(); r.bvhBuilder = 'tinybvh';
  const meshes = [new Mesh(shared, new OpenPBRMaterial()), new Mesh(shared, new OpenPBRMaterial())];
  const result: PrepareSceneResult = await r.prepareScene({meshes});
  expect(result).toEqual({geometryCount: 1, bvhTimeMs: 2});
  expect(await r.prepareScene(meshes)).toEqual({geometryCount: 0, bvhTimeMs: 0});
  expect(buildTinyBvh).toHaveBeenCalledOnce();
});

it('rebuilds static BLASes with new buffers while preserving dynamic geometry', async () => {
  const r = renderer(), a = mesh(), dynamic = mesh(); dynamic.geometry.dynamic = true;
  dynamic.geometry.bvh = buildBLAS(dynamic.geometry);
  const oldDynamic = dynamic.geometry.bvh;
  await r.prepareScene([a, dynamic]); const old = a.geometry.bvh;
  const options: PrepareSceneOptions = {rebuild: true};
  const rebuilt = await r.prepareScene([a, dynamic], options);
  expect(rebuilt.geometryCount).toBe(1); expect(rebuilt.bvhTimeMs).toBeGreaterThan(0);
  expect(a.geometry.bvh!.buffer).not.toBe(old!.buffer);
  expect(dynamic.geometry.bvh).toBe(oldDynamic);
  expect(new Uint8Array(a.geometry.bvh!.buffer)).toEqual(new Uint8Array(old!.buffer));
});

it.each(['bvh2', 'bvh4', 'bvh-gpu', 'cwbvh'] as TinyBvhLayout[])('passes %s to TinyBVH', async layout => {
  const r = renderer(); expect(r.bvhLayout).toBe('bvh2');
  r.bvhBuilder = 'tinybvh'; r.bvhLayout = layout;
  const m = mesh(); await r.prepareScene([m]);
  expect(buildTinyBvh).toHaveBeenLastCalledWith(m.geometry, 0, undefined, layout, false);
  expect(m.geometry.bvh?.layout).toBe(layout);
});

it('keeps builtin geometry and Worker requests in bvh2 regardless of bvhLayout', async () => {
  const r = renderer(); r.bvhLayout = 'cwbvh';
  const main = mesh(); await r.prepareScene([main]);
  expect(main.geometry.bvh?.layout).toBe('bvh2'); expect(buildTinyBvh).not.toHaveBeenCalled();
  vi.stubGlobal('Worker', class {});
  const build = vi.spyOn(worker, 'buildBvhInWorker').mockImplementation(async (geometry) => buildBLAS(geometry));
  const other = mesh(); await r.prepareScene([other]);
  expect(build).toHaveBeenCalledWith(other.geometry, 0, undefined, 'builtin', 'bvh2', false, expect.any(worker.BvhWorkerPool));
  expect(other.geometry.bvh?.layout).toBe('bvh2');
});

it('reports monotonic progress ending at one and no progress for an empty call', async () => {
  vi.stubGlobal('Worker', class {});
  const build = vi.spyOn(worker, 'buildBvhInWorker').mockImplementation(async geometry => ({...buildBLAS(geometry), bvhTimeMs: 2}));
  const r = renderer();
  const onProgress = vi.fn();
  expect(await r.prepareScene([mesh(), mesh(), mesh()], {onProgress})).toEqual({geometryCount: 3, bvhTimeMs: 6});
  expect(build).toHaveBeenCalledTimes(3);
  expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([1 / 3, 2 / 3, 1]);
  onProgress.mockClear();
  expect(await r.prepareScene([], {onProgress})).toEqual({geometryCount: 0, bvhTimeMs: 0});
  expect(onProgress).not.toHaveBeenCalled();
});

it('reads builder settings when a queued preparation actually starts', async () => {
  vi.stubGlobal('Worker', class {});
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  const build = vi.spyOn(worker, 'buildBvhInWorker').mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}))
    .mockImplementation(async (geometry, _scale, _displacement, builder, layout) => ({...buildBLAS(geometry), builder, layout}));
  const r = renderer(), a = mesh(), b = mesh();
  const first = r.prepareScene([a]); await Promise.resolve();
  const next = r.prepareScene([b]);
  r.bvhBuilder = 'tinybvh'; r.bvhLayout = 'cwbvh'; r.bvhSpatialSplits = true;
  finish(buildBLAS(a.geometry)); await first; await next;
  expect(build.mock.calls[0][3]).toBe('builtin');
  expect(build).toHaveBeenLastCalledWith(b.geometry, 0, undefined, 'tinybvh', 'cwbvh', true, expect.any(worker.BvhWorkerPool));
});

it('rejects invalid TinyBVH output internally and builds builtin during the same call', async () => {
  vi.mocked(buildTinyBvh).mockResolvedValueOnce({builder: 'tinybvh', layout: 'bvh2', buffer: new ArrayBuffer(0), maxDepth: 1, bvhTimeMs: 2});
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const r = renderer(), m = mesh(); r.bvhBuilder = 'tinybvh';
  expect((await r.prepareScene([m])).geometryCount).toBe(1);
  expect(m.geometry.bvh?.builder).toBe('builtin');
  expect((r as any)._tinyBvhUnavailable).toBe(true);
});
