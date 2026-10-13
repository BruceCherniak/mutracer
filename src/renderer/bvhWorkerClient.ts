import type Geometry from '../scene/Geometry.js';
import type { FlattendBVH, BvhLayout } from './bvhAccel.js';

export interface BvhBuildRequest {
  id: number;
  position: Geometry['position'];
  normal?: Geometry['normal'];
  indices: Geometry['indices'];
  dynamic: boolean;
  builder: 'builtin' | 'tinybvh';
  layout: BvhLayout;
  displacementScale: number;
  trianglesDisplacement?: Float32Array;
  spatialSplits: boolean;
}

export type BvhBuildResponse =
  | { id: number; bvh: FlattendBVH }
  | { id: number; error: string };

/** Worker transport or startup failure; retry the builder on the calling thread. */
export class BvhWorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BvhWorkerUnavailableError';
  }
}

/** Explicit pool shutdown; callers must not retry cancelled builds. */
export class BvhWorkerDisposedError extends Error {
  constructor() {
    super('BVH worker pool was disposed.');
    this.name = 'BvhWorkerDisposedError';
  }
}

/** Conservative automatic limit; explicit counts are not capped by CPU count. */
export function resolveBvhWorkerCount(count: number | 'auto') {
  if (count !== 'auto') {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('bvhWorkerCount must be "auto" or a positive safe integer.');
    }
    return count;
  }
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency;
  return Number.isFinite(cores) ? Math.max(1, Math.min(4, Math.floor(cores) - 1)) : 1;
}

/** Internal reusable client; transfer owned copies, keeping source arrays attached. */
export class BvhWorkerClient {
  private nextId = 0;
  private pending = new Map<number, {
    resolve: (bvh: FlattendBVH) => void;
    reject: (error: Error) => void;
  }>();
  private failed = false;

  constructor(private worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<BvhBuildResponse>) => {
      const task = this.pending.get(data.id);
      if (!task) return;
      this.pending.delete(data.id);
      if ('error' in data) task.reject(new Error(data.error));
      else task.resolve(data.bvh);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new BvhWorkerUnavailableError(event.message || 'BVH worker failed.'));
    };
    worker.onmessageerror = () => this.fail(new BvhWorkerUnavailableError('Unable to receive BVH worker result.'));
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = true;
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    this.worker.terminate();
    this.pending.forEach(task => task.reject(error));
    this.pending.clear();
  }

  dispose() {
    this.fail(new BvhWorkerDisposedError());
  }

  build(request: Omit<BvhBuildRequest, 'id'>): Promise<FlattendBVH> {
    if (this.failed) return Promise.reject(new BvhWorkerUnavailableError('BVH worker is unavailable.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // Copy only each view's range: a GLTF accessor may reference a much
        // larger backing buffer. Transfer these owned copies, never the source.
        const position = { ...request.position, array: request.position.array.slice() };
        const indices = { ...request.indices, array: request.indices.array.slice() };
        const normal = request.normal && { ...request.normal, array: request.normal.array.slice() };
        const trianglesDisplacement = request.trianglesDisplacement?.slice();
        const transfers = [position.array.buffer, indices.array.buffer];
        if (normal) transfers.push(normal.array.buffer);
        if (trianglesDisplacement) transfers.push(trianglesDisplacement.buffer);
        this.worker.postMessage({ ...request, id, position, indices, normal, trianglesDisplacement }, transfers);
      } catch (error) {
        this.fail(new BvhWorkerUnavailableError(error instanceof Error ? error.message : String(error)));
      }
    });
  }
}

type PoolJob = {
  request: Omit<BvhBuildRequest, 'id'>;
  resolve: (bvh: FlattendBVH) => void;
  reject: (error: Error) => void;
};
type PoolSlot = { client: BvhWorkerClient; busy: boolean };

/** Lazy reusable pool: at most one cloned input is in flight per Worker. */
export class BvhWorkerPool {
  private slots: PoolSlot[] = [];
  private queue: PoolJob[] = [];
  private stopped?: Error;

  constructor(readonly size: number) {
    resolveBvhWorkerCount(size);
  }

  build(request: Omit<BvhBuildRequest, 'id'>): Promise<FlattendBVH> {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.dispatch();
    });
  }

  private stop(error: Error) {
    this.stopped ??= error;
    for (const job of this.queue.splice(0)) job.reject(this.stopped);
  }

  private dispatch() {
    while (this.queue.length && !this.stopped) {
      let slot = this.slots.find(slot => !slot.busy);
      if (!slot) {
        if (this.slots.length >= this.size) return;
        try {
          slot = { client: new BvhWorkerClient(
            new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' })
          ), busy: false };
          this.slots.push(slot);
        } catch (error) {
          this.stop(new BvhWorkerUnavailableError(error instanceof Error ? error.message : String(error)));
          return;
        }
      }
      const job = this.queue.shift()!;
      const active = slot;
      active.busy = true;
      void active.client.build(job.request).then(job.resolve, error => {
        if (error instanceof BvhWorkerUnavailableError) this.stop(error);
        job.reject(error);
      }).finally(() => {
        active.busy = false;
        this.dispatch();
      });
    }
  }

  dispose() {
    this.stop(new BvhWorkerDisposedError());
    for (const slot of this.slots) slot.client.dispose();
    this.slots = [];
  }
}

/** Supports nested workers too; startup/transport failures use the existing calling-thread fallback. */
export function canUseBvhWorker() {
  return typeof Worker !== 'undefined';
}

export async function buildBvhInWorker(
  geometry: Geometry,
  displacementScale = 0,
  trianglesDisplacement?: Float32Array,
  builder: 'builtin' | 'tinybvh' = 'builtin',
  layout: BvhLayout = 'bvh2',
  spatialSplits = false,
  pool?: BvhWorkerPool
) {
  const activePool = pool ?? new BvhWorkerPool(1);
  try {
    return await activePool.build({
      position: geometry.position,
      normal: trianglesDisplacement ? geometry.normal : undefined,
      indices: geometry.indices,
      dynamic: geometry.dynamic,
      builder, layout, displacementScale, trianglesDisplacement, spatialSplits
    });
  } finally {
    if (!pool) activePool.dispose();
  }
}
