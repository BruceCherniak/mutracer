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

/** Internal reusable client; cloning inputs keeps renderer-owned arrays attached. */
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
      this.fail(new Error(event.message || 'BVH worker failed.'));
    };
    worker.onmessageerror = () => this.fail(new Error('Unable to receive BVH worker result.'));
  }

  private fail(error: Error) {
    this.failed = true;
    this.worker.terminate();
    this.pending.forEach(task => task.reject(error));
    this.pending.clear();
  }

  build(request: Omit<BvhBuildRequest, 'id'>): Promise<FlattendBVH> {
    if (this.failed) return Promise.reject(new Error('BVH worker is unavailable.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        // Structured clone preserves subarray offsets and shared source buffers.
        // Never transfer source geometry: it may still be rendered or shared.
        this.worker.postMessage({ ...request, id });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

let client: BvhWorkerClient | undefined;

export function canUseBvhWorker() {
  return typeof Worker !== 'undefined';
}

export function buildBvhInWorker(
  geometry: Geometry,
  displacementScale = 0,
  trianglesDisplacement?: Float32Array,
  builder: 'builtin' | 'tinybvh' = 'builtin',
  layout: BvhLayout = 'bvh2',
  spatialSplits = false
) {
  client ??= new BvhWorkerClient(new Worker(new URL('./bvh.worker.ts', import.meta.url), { type: 'module' }));
  return client.build({
    position: geometry.position,
    normal: trianglesDisplacement ? geometry.normal : undefined,
    indices: geometry.indices,
    dynamic: geometry.dynamic,
    builder, layout, displacementScale, trianglesDisplacement, spatialSplits
  });
}
