import type { SkyBaker, SkyData } from './sky';

export type SkyBakeResponse = { data: SkyData } | { error: string };

/** Keeps GPU readback off the UI thread; the caller allows one bake at a time. */
export class SkyWorker {
  private worker?: Worker;
  private failed = false;
  private disposed = false;
  private pending?: { resolve: (data: SkyData) => void; reject: (error: Error) => void };

  constructor(private readonly fallback: Pick<SkyBaker, 'bake'>) {}

  async bake(hours: number): Promise<SkyData> {
    if (this.disposed) throw new Error('Sky worker is disposed.');
    if (this.pending) throw new Error('A sky bake is already in progress.');
    if (this.failed || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return this.fallback.bake(hours);
    try {
      if (!this.worker) {
        this.worker = new Worker(new URL('./sky.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = ({ data }: MessageEvent<SkyBakeResponse>) => {
          const pending = this.pending;
          this.pending = undefined;
          if ('error' in data) pending?.reject(new Error(data.error));
          else pending?.resolve(data.data);
        };
        const fail = (error: Error) => {
          this.failed = true;
          this.worker?.terminate();
          this.worker = undefined;
          this.pending?.reject(error);
          this.pending = undefined;
        };
        this.worker.onerror = (event) => {
          event.preventDefault();
          fail(new Error(event.message || 'Sky worker failed.'));
        };
        this.worker.onmessageerror = () => fail(new Error('Could not read the sky worker response.'));
      }
      return await new Promise<SkyData>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.worker!.postMessage(hours);
      });
    } catch (error) {
      this.pending = undefined;
      this.worker?.terminate();
      this.worker = undefined;
      this.failed = true;
      if (this.disposed) throw error;
      // Some browsers support OffscreenCanvas but cannot create WebGL in a worker.
      return this.fallback.bake(hours);
    }
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    this.pending?.reject(new Error('Sky worker is disposed.'));
    this.pending = undefined;
  }
}
