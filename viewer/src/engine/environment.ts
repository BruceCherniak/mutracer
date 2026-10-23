import * as THREE from 'three';
import { parseRGBE } from '@meimu/mutracer';
import { fetchWithProgress } from './fetchWithProgress';
import { openHDRCache } from './hdrCache';
import { DEFAULT_SKY_TIME, createSkyAt } from './sky';

export interface EquirectData {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Physically based clear sky at a local solar time. Same mapping as
 * examples/shared/sky.ts (v = 0 is +Y, u follows atan2(-z, -x)).
 */
export function createSky(hours = DEFAULT_SKY_TIME, width = 1024, height = 512): EquirectData {
  return createSkyAt(hours, width, height);
}

/**
 * Builds skies off the main thread, one at a time. A request that has not
 * started when a newer one arrives resolves to `undefined`.
 */
export class SkyGenerator {
  private worker?: Worker;
  private busy = false;
  private queued?: { hours: number; resolve: (sky?: EquirectData) => void };

  generate(hours: number): Promise<EquirectData | undefined> {
    if (typeof Worker === 'undefined') return Promise.resolve(createSky(hours));
    return new Promise((resolve) => {
      this.queued?.resolve(undefined);
      this.queued = { hours, resolve };
      this.next();
    });
  }

  private next() {
    if (this.busy || !this.queued) return;
    const { hours, resolve } = this.queued;
    this.queued = undefined;
    this.busy = true;
    const done = (sky: EquirectData) => {
      this.busy = false;
      resolve(sky);
      this.next();
    };
    try {
      this.worker ??= new Worker(new URL('./sky.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<EquirectData>) => done(event.data);
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = undefined;
        done(createSky(hours));
      };
      this.worker.postMessage(hours);
    } catch {
      done(createSky(hours));
    }
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    this.queued?.resolve(undefined);
    this.queued = undefined;
  }
}

export function parseHDR(buffer: ArrayBuffer): EquirectData {
  const texture = parseRGBE(buffer);
  const image = texture?.image as EquirectData | undefined;
  if (!image?.data) throw new Error('Not a Radiance .hdr file');
  return { data: image.data as Float32Array, width: image.width, height: image.height };
}

export async function loadHDR(url: string, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cache = await openHDRCache(url);
  const cached = await cache?.read();
  signal?.throwIfAborted();
  if (cached) {
    let data: EquirectData | undefined;
    try {
      data = parseHDR(cached);
    } catch {
      await cache?.remove();
    }
    if (data) {
      onProgress?.(cached.byteLength, cached.byteLength);
      return data;
    }
  }
  const buffer = await fetchWithProgress(url, onProgress, signal);
  signal?.throwIfAborted();
  const data = parseHDR(buffer);
  // Validate before persisting so an error response cannot poison future loads.
  await cache?.write(buffer);
  return data;
}

/** Owns source radiance; intensity and orientation are scene parameters. */
export class Environment {
  texture: THREE.DataTexture;
  private source: EquirectData;
  private tint: [number, number, number] = [1, 1, 1];

  constructor(source: EquirectData) {
    this.source = source;
    this.texture = this.createTexture(source);
    this.applyTint();
  }

  private createTexture(source: EquirectData) {
    const texture = new THREE.DataTexture(source.data, source.width, source.height, THREE.RGBAFormat, THREE.FloatType);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.LinearSRGBColorSpace;
    // Source rows start at the sky, as in an .hdr file.
    texture.flipY = true;
    return texture;
  }

  /** Replaces the pixels. Allocates a new texture when the size changes. */
  setSource(source: EquirectData) {
    this.source = source;
    const image = this.texture.image as EquirectData;
    if (image.width !== source.width || image.height !== source.height) {
      this.texture.dispose();
      this.texture = this.createTexture(source);
    }
    this.applyTint();
  }

  /** Color edits change radiance; intensity and orientation remain scene parameters. */
  setTint(tint: [number, number, number]) {
    if (tint.every((c, i) => c === this.tint[i])) return;
    this.tint = [...tint];
    this.applyTint();
  }

  apply(scene: THREE.Scene, intensity: number, rotationDegrees = 0) {
    scene.environment = this.texture;
    scene.environmentIntensity = intensity;
    scene.environmentRotation.set(0, THREE.MathUtils.degToRad(((rotationDegrees % 360) + 360) % 360), 0);
  }

  private applyTint() {
    const {data, width, height} = this.source;
    if (this.tint.every(c => c === 1)) this.texture.image = {data, width, height};
    else {
      const tinted = new Float32Array(data.length);
      for (let i = 0; i < data.length; i++) tinted[i] = data[i] * (i % 4 === 3 ? 1 : this.tint[i % 4]);
      this.texture.image = {data:tinted, width, height};
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
