import { prepareStats } from '../helpers/prepareStats';
import { setGeometryBvh, getGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine, type TinyBvhLayout } from '../../src/main';
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
function renderer() { return new Engine({canvas: {width: 1, height: 1} as HTMLCanvasElement}); }
function mesh() { return new Mesh(createCubeGeometry(), new OpenPBRMaterial()); }

it('counts shared static geometry once, reports builder time and skips cached BLASes', async () => {
  const shared = createCubeGeometry(), r = renderer(); r.bvhBuilder = 'tinybvh';
  const meshes = [new Mesh(shared, new OpenPBRMaterial()), new Mesh(shared, new OpenPBRMaterial())];
  const result = await prepareStats(r, {meshes});
  expect(result).toEqual({geometryCount: 1, bvhTimeMs: 2});
  expect(await prepareStats(r, meshes)).toEqual({geometryCount: 0, bvhTimeMs: 0});
  expect(buildTinyBvh).toHaveBeenCalledOnce();
});

it('rebuilds static BLASes with new buffers while preserving dynamic geometry', async () => {
  const r = renderer(), a = mesh(), dynamic = mesh(); dynamic.geometry.dynamic = true;
  setGeometryBvh(dynamic.geometry, buildBLAS(dynamic.geometry));
  const oldDynamic = getGeometryBvh(dynamic.geometry);
  await prepareStats(r, [a, dynamic]); const old = getGeometryBvh(a.geometry);
  r.bvhSpatialSplits = true;
  const rebuilt = await prepareStats(r, [a, dynamic]);
  expect(rebuilt.geometryCount).toBe(1); expect(rebuilt.bvhTimeMs).toBeGreaterThan(0);
  expect(getGeometryBvh(a.geometry)!.buffer).not.toBe(old!.buffer);
  expect(getGeometryBvh(dynamic.geometry)).toBe(oldDynamic);
  expect(new Uint8Array(getGeometryBvh(a.geometry)!.buffer)).toEqual(new Uint8Array(old!.buffer));
});

it.each(['bvh2', 'bvh4', 'bvh-gpu', 'cwbvh'] as TinyBvhLayout[])('passes %s to TinyBVH', async layout => {
  const r = renderer(); expect(r.bvhLayout).toBe('bvh2');
  r.bvhBuilder = 'tinybvh'; r.bvhLayout = layout;
  const m = mesh(); await prepareStats(r, [m]);
  expect(buildTinyBvh).toHaveBeenLastCalledWith(m.geometry, 0, undefined, layout, false);
  expect(getGeometryBvh(m.geometry)?.layout).toBe(layout);
});

it('keeps builtin geometry and Worker requests in bvh2 regardless of bvhLayout', async () => {
  const r = renderer(); r.bvhLayout = 'cwbvh';
  const main = mesh(); await prepareStats(r, [main]);
  expect(getGeometryBvh(main.geometry)?.layout).toBe('bvh2'); expect(buildTinyBvh).not.toHaveBeenCalled();
  vi.stubGlobal('Worker', class {});
  const build = vi.spyOn(worker, 'buildBvhInWorker').mockImplementation(async (geometry) => buildBLAS(geometry));
  const other = mesh(); await prepareStats(r, [other]);
  expect(build).toHaveBeenCalledWith(other.geometry, 0, undefined, 'builtin', 'bvh2', false, expect.any(worker.BvhWorkerPool));
  expect(getGeometryBvh(other.geometry)?.layout).toBe('bvh2');
});

it('reports monotonic progress ending at one and no progress for an empty call', async () => {
  vi.stubGlobal('Worker', class {});
  const build = vi.spyOn(worker, 'buildBvhInWorker').mockImplementation(async geometry => ({...buildBLAS(geometry), bvhTimeMs: 2}));
  const r = renderer();
  const onProgress = vi.fn();
  expect(await prepareStats(r, [mesh(), mesh(), mesh()], {onProgress})).toEqual({geometryCount: 3, bvhTimeMs: 6});
  expect(build).toHaveBeenCalledTimes(3);
  expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([1 / 3, 2 / 3, 1]);
  onProgress.mockClear();
  expect(await prepareStats(r, [], {onProgress})).toEqual({geometryCount: 0, bvhTimeMs: 0});
  expect(onProgress).not.toHaveBeenCalled();
});

it('reads builder settings when a queued preparation actually starts', async () => {
  vi.stubGlobal('Worker', class {});
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  const build = vi.spyOn(worker, 'buildBvhInWorker').mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}))
    .mockImplementation(async (geometry, _scale, _displacement, builder, layout) => ({...buildBLAS(geometry), builder, layout}));
  const r = renderer(), a = mesh(), b = mesh();
  const first = prepareStats(r, [a]); await Promise.resolve();
  const next = prepareStats(r, [b]);
  r.bvhBuilder = 'tinybvh'; r.bvhLayout = 'cwbvh'; r.bvhSpatialSplits = true;
  finish(buildBLAS(a.geometry)); await first; await next;
  expect(build.mock.calls[0][3]).toBe('builtin');
  expect(build).toHaveBeenLastCalledWith(b.geometry, 0, undefined, 'tinybvh', 'cwbvh', true, expect.any(worker.BvhWorkerPool));
});

it('rejects invalid TinyBVH output internally and builds builtin during the same call', async () => {
  vi.mocked(buildTinyBvh).mockResolvedValueOnce({builder: 'tinybvh', layout: 'bvh2', buffer: new ArrayBuffer(0), maxDepth: 1, bvhTimeMs: 2});
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const r = renderer(), m = mesh(); r.bvhBuilder = 'tinybvh';
  expect((await prepareStats(r, [m])).geometryCount).toBe(1);
  expect(getGeometryBvh(m.geometry)?.builder).toBe('builtin');
  expect((r as any)._tinyBvhUnavailable).toBe(true);
});

it('exposes build diagnostics before device initialization and rejects aborted preparation', async () => {
 const r=renderer();await prepareStats(r, [mesh()]);
 expect(r.backend).toBeUndefined();expect(r.getDiagnostics()?.backend).toBeUndefined();expect(r.getDiagnostics()?.bvh?.lastBuild?.geometryCount).toBe(1);
 const controller=new AbortController();controller.abort(new Error('cancel build'));
 await expect(prepareStats(r, [mesh()],{signal:controller.signal})).rejects.toThrow('cancel build');
});

it('rejects an active abort without accepting its eventual worker output', async () => {
 vi.stubGlobal('Worker',class{});let finish!: (value: ReturnType<typeof buildBLAS>)=>void;
 vi.spyOn(worker,'buildBvhInWorker').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const r=renderer(),m=mesh(),controller=new AbortController();
 const pending=prepareStats(r, [m],{signal:controller.signal});await Promise.resolve();controller.abort(new Error('active abort'));
 await expect(pending).rejects.toThrow('active abort');finish(buildBLAS(m.geometry));await (r as any)._bvhPreparationTail;
 expect(getGeometryBvh(m.geometry)).toBeUndefined();
});
