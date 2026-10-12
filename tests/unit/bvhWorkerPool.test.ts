import { getGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Renderer, Mesh, OpenPBRMaterial, createCubeGeometry, createSphereGeometry } from '../../src/main';
import { Attribute } from '../../src/scene/Geometry';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import {
  BvhWorkerClient, BvhWorkerPool, BvhWorkerDisposedError, BvhWorkerUnavailableError,
  resolveBvhWorkerCount, type BvhBuildRequest
} from '../../src/renderer/bvhWorkerClient';

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  sent: BvhBuildRequest[] = [];
  terminate = vi.fn();
  constructor() { ControlledWorker.instances.push(this); }
  postMessage(data: BvhBuildRequest, transfers: Transferable[]) {
    this.sent.push(structuredClone(data, { transfer: transfers }));
  }
  reply(index = this.sent.length - 1) {
    this.onmessage?.call(this as unknown as Worker, {
      data: { id: this.sent[index].id, bvh: buildBLAS(createCubeGeometry()) }
    } as MessageEvent);
  }
  error(index = this.sent.length - 1) {
    this.onmessage?.call(this as unknown as Worker, {
      data: { id: this.sent[index].id, error: 'invalid geometry' }
    } as MessageEvent);
  }
  crash() {
    this.onerror?.call(this as unknown as Worker, { message: 'crashed', preventDefault() {} } as ErrorEvent);
  }
}

const renderers: Renderer[] = [];
beforeEach(() => {
  ControlledWorker.instances = [];
  vi.stubGlobal('Worker', ControlledWorker);
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
});
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function renderer(count: number | 'auto' = 'auto') {
  const r = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  r.bvhWorkerCount = count; renderers.push(r); return r;
}
function mesh() { return new Mesh(createCubeGeometry(), new OpenPBRMaterial()); }
function request(): Omit<BvhBuildRequest, 'id'> {
  const geometry = createCubeGeometry();
  return { position: geometry.position, indices: geometry.indices, dynamic: false,
    builder: 'builtin', layout: 'bvh2', displacementScale: 0, spatialSplits: false };
}

it('bounds active Workers and sends the next input only when a Worker becomes free', async () => {
  const pool = new BvhWorkerPool(2);
  expect(ControlledWorker.instances).toHaveLength(0);
  const tasks = Array.from({ length: 5 }, () => pool.build(request()));
  const [a, b] = ControlledWorker.instances;
  expect(ControlledWorker.instances).toHaveLength(2);
  expect([a.sent.length, b.sent.length]).toEqual([1, 1]);
  b.reply(); await tasks[1];
  await vi.waitFor(() => expect(b.sent).toHaveLength(2));
  expect(a.sent).toHaveLength(1);
  a.reply(); await tasks[0];
  await vi.waitFor(() => expect(a.sent).toHaveLength(2));
  b.reply(); await tasks[2];
  await vi.waitFor(() => expect(b.sent).toHaveLength(3));
  a.reply(); b.reply(); await Promise.all(tasks);
  const reused = pool.build(request());
  expect(ControlledWorker.instances).toHaveLength(2);
  a.reply(); await reused;
  pool.dispose(); pool.dispose();
  expect(a.terminate).toHaveBeenCalledOnce(); expect(b.terminate).toHaveBeenCalledOnce();
});

it('copies only view ranges, transfers copies and preserves renderer-owned buffers', async () => {
  const w = new ControlledWorker(), client = new BvhWorkerClient(w as unknown as Worker);
  const input = request();
  const backing = new Float32Array(100_000);
  backing.set(input.position.array, 20);
  input.position = new Attribute(backing.subarray(20, 20 + input.position.array.length), 3);
  const normals = new Float32Array(100_000).fill(1);
  input.normal = new Attribute(normals.subarray(40, 40 + input.position.array.length), 3);
  input.trianglesDisplacement = new Float32Array(100_000).subarray(30, 54);
  const pending = client.build(input), sent = w.sent[0];
  expect(sent.position.array.buffer.byteLength).toBe(input.position.array.byteLength);
  expect(sent.position.array.byteOffset).toBe(0);
  expect(sent.position.array).toEqual(input.position.array);
  expect(sent.normal!.array.buffer.byteLength).toBe(input.normal.array.byteLength);
  expect(sent.trianglesDisplacement!.buffer.byteLength).toBe(input.trianglesDisplacement.byteLength);
  expect(backing.byteLength).toBe(400_000); expect(normals.byteLength).toBe(400_000);
  expect(input.indices.array.byteLength).toBeGreaterThan(0);
  w.reply(); await pending; client.dispose();
});

it('continues queued work after a mesh build error', async () => {
  const pool = new BvhWorkerPool(1);
  const first = pool.build(request()), second = pool.build(request());
  const rejected = expect(first).rejects.toThrow('invalid geometry');
  const w = ControlledWorker.instances[0]; w.error(); await rejected;
  await vi.waitFor(() => expect(w.sent).toHaveLength(2));
  w.reply(); await second; pool.dispose();
});

it('settles queued and active promises on shutdown without sending queued inputs', async () => {
  const pool = new BvhWorkerPool(2);
  const tasks = Array.from({ length: 4 }, () => pool.build(request()));
  const rejected = tasks.map(task => expect(task).rejects.toBeInstanceOf(BvhWorkerDisposedError));
  pool.dispose(); await Promise.all(rejected);
  expect(ControlledWorker.instances.map(w => w.sent.length)).toEqual([1, 1]);
  await expect(pool.build(request())).rejects.toBeInstanceOf(BvhWorkerDisposedError);
});

it('stops new dispatch after a crash while allowing an already active healthy Worker to finish', async () => {
  const pool = new BvhWorkerPool(2);
  const first = pool.build(request()), healthy = pool.build(request()), queued = pool.build(request());
  const assertions = [expect(first).rejects.toBeInstanceOf(BvhWorkerUnavailableError),
    expect(queued).rejects.toBeInstanceOf(BvhWorkerUnavailableError)];
  const [a, b] = ControlledWorker.instances;
  a.crash(); await Promise.all(assertions);
  b.reply(); await healthy;
  expect(b.sent).toHaveLength(1);
  await expect(pool.build(request())).rejects.toBeInstanceOf(BvhWorkerUnavailableError);
  pool.dispose();
  expect(a.terminate).toHaveBeenCalledOnce(); expect(b.terminate).toHaveBeenCalledOnce();
});

it.each([[1, 1], [2, 1], [4, 3], [16, 4], [undefined, 1], [NaN, 1]])(
  'resolves automatic size for hardwareConcurrency %s to %s', (cores, expected) => {
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    expect(renderer().bvhWorkerCount).toBe('auto');
    expect(resolveBvhWorkerCount('auto')).toBe(expected);
  }
);

it('uses one Worker when navigator is unavailable and accepts explicit counts above CPU count', () => {
  vi.stubGlobal('navigator', undefined);
  expect(resolveBvhWorkerCount('auto')).toBe(1);
  expect(resolveBvhWorkerCount(8)).toBe(8);
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid worker count %s', count => {
  const r = renderer(2);
  expect(() => { r.bvhWorkerCount = count; }).toThrow(RangeError);
  expect(r.bvhWorkerCount).toBe(2);
});

it('deduplicates geometry, bounds preparation and reports progress in completion order', async () => {
  const r = renderer(2), meshes = [mesh(), mesh(), mesh(), mesh(), mesh()];
  const progress = vi.fn();
  const pending = r.prepareScene([...meshes, new Mesh(meshes[0].geometry, new OpenPBRMaterial())], { onProgress: progress });
  await Promise.resolve();
  const [a, b] = ControlledWorker.instances;
  expect([a.sent.length, b.sent.length]).toEqual([1, 1]);
  b.reply(); await vi.waitFor(() => expect(b.sent).toHaveLength(2));
  expect(getGeometryBvh(meshes[1].geometry)).toBeDefined();
  expect(getGeometryBvh(meshes[0].geometry)).toBeUndefined();
  a.reply(); await vi.waitFor(() => expect(a.sent).toHaveLength(2));
  b.reply(); await vi.waitFor(() => expect(b.sent).toHaveLength(3));
  a.reply(); b.reply();
  expect((await pending).geometryCount).toBe(5);
  expect(progress.mock.calls.map(([p]) => p)).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
  expect(await r.prepareScene(meshes)).toEqual({ geometryCount: 0, bvhTimeMs: 0 });
  expect(ControlledWorker.instances).toHaveLength(2);
});

it('starts large geometry first and prepares queued inputs lazily', async () => {
  const r = renderer(1), small = mesh();
  const large = new Mesh(createSphereGeometry(32, 16), new OpenPBRMaterial());
  small.geometry.normal = undefined!; small.geometry.tangent = undefined;
  const pending = r.prepareScene([small, large]); await Promise.resolve();
  const w = ControlledWorker.instances[0];
  expect(w.sent[0].indices.array.length).toBe(large.geometry.indices.array.length);
  expect(small.geometry.normal).toBeUndefined();
  w.reply(); await vi.waitFor(() => expect(w.sent).toHaveLength(2));
  expect(small.geometry.normal).toBeDefined(); w.reply(); await pending;
});

it('skips queued geometry changed before dispatch and discards stale active results', async () => {
  const r = renderer(1), meshes = [mesh(), mesh(), mesh()];
  const progress = vi.fn(), pending = r.prepareScene(meshes, { onProgress: progress });
  await Promise.resolve();
  meshes[0].geometry.markUpdated(); meshes[1].geometry.markUpdated();
  const w = ControlledWorker.instances[0]; w.reply();
  await vi.waitFor(() => expect(w.sent).toHaveLength(2));
  expect(getGeometryBvh(meshes[0].geometry)).toBeUndefined(); expect(getGeometryBvh(meshes[1].geometry)).toBeUndefined();
  w.reply(); expect((await pending).geometryCount).toBe(1);
  expect(progress.mock.calls.map(([p]) => p)).toEqual([1 / 3, 2 / 3, 1]);
});

it('reuses the pool and resizes only when the next preparation starts', async () => {
  const r = renderer(1), meshes = [mesh(), mesh()];
  const first = r.prepareScene(meshes); await Promise.resolve();
  const old = ControlledWorker.instances[0];
  r.bvhWorkerCount = 2;
  const second = r.prepareScene([mesh(), mesh()]);
  old.reply(); await vi.waitFor(() => expect(old.sent).toHaveLength(2));
  expect(ControlledWorker.instances).toHaveLength(1); expect(old.terminate).not.toHaveBeenCalled();
  old.reply(); await first;
  await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(3));
  expect(old.terminate).toHaveBeenCalledOnce();
  ControlledWorker.instances.slice(1).forEach(w => w.reply()); await second;
  const third = r.prepareScene([mesh()]); await Promise.resolve();
  expect(ControlledWorker.instances).toHaveLength(3);
  ControlledWorker.instances[1].reply(); await third;
});

it('keeps pools independent across renderers', async () => {
  const a = renderer(1), b = renderer(1);
  const first = a.prepareScene([mesh()]), second = b.prepareScene([mesh()]); await Promise.resolve();
  expect(ControlledWorker.instances).toHaveLength(2);
  a.dispose(); await first;
  expect(ControlledWorker.instances[1].terminate).not.toHaveBeenCalled();
  ControlledWorker.instances[1].reply(); expect((await second).geometryCount).toBe(1);
});

it('cancels active and queued preparations on renderer disposal without fallback or progress', async () => {
  const r = renderer(2), meshes = [mesh(), mesh(), mesh()], progress = vi.fn();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const first = r.prepareScene(meshes, { onProgress: progress }); await Promise.resolve();
  const queued = r.prepareScene([mesh()]);
  r.dispose(); r.dispose();
  expect(await first).toEqual({ geometryCount: 0, bvhTimeMs: 0 });
  expect(await queued).toEqual({ geometryCount: 0, bvhTimeMs: 0 });
  expect(meshes.every(m => !getGeometryBvh(m.geometry))).toBe(true);
  expect(progress).not.toHaveBeenCalled(); expect(warning).not.toHaveBeenCalled();
  expect(ControlledWorker.instances).toHaveLength(2);
  ControlledWorker.instances.forEach(w => expect(w.terminate).toHaveBeenCalledOnce());
});

it('falls back for unfinished jobs on crash and releases the remaining pool', async () => {
  const r = renderer(2), meshes = [mesh(), mesh(), mesh(), mesh()];
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const pending = r.prepareScene(meshes); await Promise.resolve();
  ControlledWorker.instances[0].crash(); ControlledWorker.instances[1].reply();
  expect((await pending).geometryCount).toBe(4);
  expect(meshes.every(m => getGeometryBvh(m.geometry)?.builder === 'builtin')).toBe(true);
  expect(warning).toHaveBeenCalledOnce();
  expect(ControlledWorker.instances.map(w => w.sent.length)).toEqual([1, 1]);
  ControlledWorker.instances.forEach(w => expect(w.terminate).toHaveBeenCalledOnce());
  expect((await r.prepareScene([mesh()])).geometryCount).toBe(1);
  expect(ControlledWorker.instances).toHaveLength(2);
});

it('finishes remaining jobs even when the progress callback throws', async () => {
  const r = renderer(1);
  const pending = r.prepareScene([mesh(), mesh()], { onProgress: () => { throw new Error('UI error'); } });
  await Promise.resolve(); const w = ControlledWorker.instances[0]; w.reply();
  await vi.waitFor(() => expect(w.sent).toHaveLength(2));
  w.reply(); expect((await pending).geometryCount).toBe(2);
});
