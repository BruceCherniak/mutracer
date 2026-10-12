import { getGeometryBvh, setGeometryBvh } from '../../src/renderer/geometryBvh.js';
import { afterEach, expect, it, vi } from 'vitest';
import { BvhWorkerClient, BvhWorkerUnavailableError, type BvhBuildRequest } from '../../src/renderer/bvhWorkerClient';
import { executeBvhBuild } from '../../src/renderer/bvhWorkerBuild';
import { buildBLAS } from '../../src/renderer/bvhAccel';
import { createCubeGeometry } from '../../src/util/commonGeometry';
import { getPreparedMeshGeometry } from '../../src/renderer/prepareMeshBVH';
import Geometry, { Attribute } from '../../src/scene/Geometry';
import Mesh from '../../src/scene/Mesh';
import OpenPBRMaterial from '../../src/scene/OpenPBRMaterial';
import Texture from '../../src/scene/Texture';
import Renderer from '../../src/Renderer';

afterEach(() => { vi.unstubAllGlobals(); });

function request(): BvhBuildRequest {
  const geometry = createCubeGeometry();
  return { id: 0, position: geometry.position, normal: geometry.normal, indices: geometry.indices,
    dynamic: false, builder: 'builtin', layout: 'bvh2', displacementScale: 0, spatialSplits: false };
}

class TestWorker {
  onmessage?: Worker['onmessage'];
  onerror?: Worker['onerror'];
  onmessageerror?: Worker['onmessageerror'];
  sent: BvhBuildRequest[] = [];
  terminate = vi.fn();
  postMessage(data: BvhBuildRequest) { this.sent.push(structuredClone(data)); }
  reply(id: number) {
    this.onmessage?.call(this as unknown as Worker, { data: { id, bvh: buildBLAS(createCubeGeometry()) } } as MessageEvent);
  }
}

it('routes concurrent responses by request id without detaching input geometry', async () => {
  const worker = new TestWorker();
  const client = new BvhWorkerClient(worker as unknown as Worker);
  const input = request();
  const first = client.build(input), second = client.build(input);
  expect(input.position.array.byteLength).toBeGreaterThan(0);
  expect(worker.sent[0].position.array.buffer).not.toBe(input.position.array.buffer);
  worker.reply(1); worker.reply(0);
  expect((await second).buffer.byteLength).toBeGreaterThan(0);
  expect((await first).buffer.byteLength).toBeGreaterThan(0);
});

it('rejects all pending builds and terminates a crashed worker', async () => {
  const worker = new TestWorker();
  const client = new BvhWorkerClient(worker as unknown as Worker);
  const builds = [client.build(request()), client.build(request())];
  const assertions = builds.map(build => expect(build).rejects.toThrow('crashed'));
  worker.onerror?.call(worker as unknown as Worker, { message: 'crashed', preventDefault() {} } as ErrorEvent);
  await Promise.all(assertions);
  expect(worker.terminate).toHaveBeenCalledOnce();
  await expect(client.build(request())).rejects.toThrow('unavailable');
});

it('propagates build failures while allowing subsequent requests', async () => {
  const worker = new TestWorker();
  const client = new BvhWorkerClient(worker as unknown as Worker);
  const failed = client.build(request());
  worker.onmessage?.call(worker as unknown as Worker, { data: { id: 0, error: 'invalid mesh' } } as MessageEvent);
  await expect(failed).rejects.toThrow('invalid mesh');
  const next = client.build(request()); worker.reply(1); await next;
});

it('produces identical built-in BVH bytes for subarray and displaced inputs', async () => {
  const input = request();
  const padded = new Float32Array(input.position.array.length + 8);
  padded.set(input.position.array, 4);
  input.position = new Attribute(padded.subarray(4, padded.length - 4), 3);
  input.displacementScale = 0.3;
  input.trianglesDisplacement = new Float32Array(input.indices.array.length / 3 * 2).fill(0.5);
  const result = await executeBvhBuild(structuredClone(input));
  const reference = buildBLAS(new Geometry(input), input.displacementScale, input.trianglesDisplacement);
  expect(new Uint8Array(result.buffer)).toEqual(new Uint8Array(reference.buffer));
  expect(result.maxDepth).toBe(reference.maxDepth);
  expect(result.maxLeafPrimitives).toBe(reference.maxLeafPrimitives);
});

it('keeps dynamic meshes in the built-in layout even for a TinyBVH request', async () => {
  const result = await executeBvhBuild({ ...request(), builder: 'tinybvh', dynamic: true, layout: 'cwbvh' });
  expect(result.builder).toBe('builtin'); expect(result.layout).toBe('bvh2');
});

it('falls back within the call when Worker construction is blocked', async () => {
  vi.stubGlobal('Worker', class { constructor() { throw new Error('CSP blocked'); } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    await renderer.prepareScene([mesh]);
    expect(getGeometryBvh(mesh.geometry)?.builder).toBe('builtin');
    expect((renderer as any)._bvhWorkerUnavailable).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
  } finally { warning.mockRestore(); }
});

it('prepares builtin renderer BLASes asynchronously when Workers are available', async () => {
  class AutoWorker extends TestWorker {
    postMessage(data: BvhBuildRequest) {
      super.postMessage(data);
      void executeBvhBuild(this.sent[this.sent.length - 1]).then(bvh =>
        this.onmessage?.call(this as unknown as Worker, { data: { id: data.id, bvh } } as MessageEvent));
    }
  }
  vi.stubGlobal('Worker', AutoWorker);
  const geometry = createCubeGeometry();
  const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
  const build = renderer.prepareScene([new Mesh(geometry, new OpenPBRMaterial())]);
  expect(getGeometryBvh(geometry)).toBeUndefined();
  await build;
  expect(new Uint8Array(getGeometryBvh(geometry)!.buffer)).toEqual(new Uint8Array(buildBLAS(geometry).buffer));
});

it('falls back after Worker failure without retrying the same geometry every frame', async () => {
  vi.stubGlobal('Worker', TestWorker);
  const build = vi.spyOn(BvhWorkerClient.prototype, 'build').mockRejectedValue(new BvhWorkerUnavailableError('worker blocked'));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    await renderer.prepareScene([mesh]);
    expect(getGeometryBvh(mesh.geometry)?.builder).toBe('builtin');
    expect((renderer as any)._bvhWorkerUnavailable).toBe(true);
    expect(warning).toHaveBeenCalledOnce();
    expect((renderer as any)._needsBVHPreparation([mesh])).toBe(false);
  } finally { build.mockRestore(); warning.mockRestore(); }
});

it('retries an input changed during Worker preparation instead of accepting the stale BVH', async () => {
  vi.stubGlobal('Worker', TestWorker);
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  const build = vi.spyOn(BvhWorkerClient.prototype, 'build').mockImplementation(() =>
    new Promise(resolve => { finish = resolve; }));
  try {
    const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
    const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
    const pending = renderer.prepareScene([mesh]);
    await Promise.resolve();
    mesh.geometry.markUpdated();
    finish(buildBLAS(mesh.geometry));
    await pending;
    expect(getGeometryBvh(mesh.geometry)).toBeUndefined();
    expect((renderer as any)._needsBVHPreparation([mesh])).toBe(true);
  } finally { build.mockRestore(); }
});

it('classifies postMessage and message decoding failures as Worker unavailability', async () => {
  const blocked = new TestWorker();
  blocked.postMessage = () => { throw new Error('clone failed'); };
  const client = new BvhWorkerClient(blocked as unknown as Worker);
  await expect(client.build(request())).rejects.toBeInstanceOf(BvhWorkerUnavailableError);
  await expect(client.build(request())).rejects.toBeInstanceOf(BvhWorkerUnavailableError);
  expect(blocked.terminate).toHaveBeenCalledOnce();
  const invalid = new TestWorker();
  const second = new BvhWorkerClient(invalid as unknown as Worker);
  const pending = second.build(request());
  const assertion = expect(pending).rejects.toBeInstanceOf(BvhWorkerUnavailableError);
  invalid.onmessageerror?.call(invalid as unknown as Worker, {} as MessageEvent);
  await assertion;
});

it('discards results when geometry, revision, or preparation settings change', async () => {
  vi.stubGlobal('Worker', TestWorker);
  let finish!: (bvh: ReturnType<typeof buildBLAS>) => void;
  const build = vi.spyOn(BvhWorkerClient.prototype, 'build').mockImplementation(() =>
    new Promise(resolve => { finish = resolve; }));
  try {
    for (const change of ['revision', 'geometry', 'settings', 'bvh', 'displacement', 'texture', 'textureVersion']) {
      const mesh = new Mesh(createCubeGeometry(), new OpenPBRMaterial());
      const material = mesh.materials[0];
      material.displacementMap = new Texture({ data: new Uint8Array(64).fill(128), width: 4, height: 4 });
      material.displacementScale = 0.1;
      const target = getPreparedMeshGeometry(mesh);
      const renderer = new Renderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement });
      const pending = renderer.prepareScene([mesh]); await Promise.resolve();
      if (change === 'revision') mesh.geometry.markUpdated();
      if (change === 'geometry') mesh.geometry = createCubeGeometry();
      if (change === 'displacement') material.displacementScale = 0.3;
      if (change === 'settings') material.displacementUvProjection = 'triplanar';
      if (change === 'texture') material.displacementMap = new Texture({ data: new Uint8Array(64), width: 4, height: 4 });
      if (change === 'textureVersion') material.displacementMap.markUpdated();
      const newer = change === 'bvh' ? buildBLAS(target) : undefined;
      setGeometryBvh(target, newer);
      finish(buildBLAS(target)); await pending;
      expect(getGeometryBvh(target)).toBe(newer);
    }
  } finally { build.mockRestore(); }
});
