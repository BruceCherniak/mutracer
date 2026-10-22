import * as THREE from 'three';
import { parseRGBE } from '@meimu/mutracer';
import { fetchWithProgress } from './fetchWithProgress';
import { openHDRCache } from './hdrCache';

export interface EquirectData {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Procedural equirectangular sky: zenith-to-horizon gradient, darker ground
 * and a small sun. Same mapping as examples/shared/sky.ts (v = 0 is +Y, u
 * follows atan2(-z, -x)). Used offline and as the default.
 */
export function createSky(width = 1024, height = 512): EquirectData {
  const data = new Float32Array(width * height * 4);
  const elevation = (32 * Math.PI) / 180;
  const azimuth = (50 * Math.PI) / 180;
  const sun = [Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth)];
  const sunCos = Math.cos((0.6 * Math.PI) / 180);
  const zenith = [0.18, 0.36, 0.78];
  const horizon = [0.85, 0.85, 0.82];
  const ground = [0.16, 0.15, 0.14];
  for (let row = 0; row < height; row++) {
    const theta = ((row + 0.5) / height) * Math.PI;
    const y = Math.cos(theta);
    for (let col = 0; col < width; col++) {
      const phi = ((col + 0.5) / width) * 2 * Math.PI;
      const x = -Math.sin(theta) * Math.cos(phi);
      const z = -Math.sin(theta) * Math.sin(phi);
      let color: number[];
      if (y >= 0) {
        const t = Math.pow(1 - y, 4);
        color = zenith.map((c, i) => c + (horizon[i] - c) * t);
      } else {
        const t = Math.min(1, -y * 8);
        color = horizon.map((c, i) => c + (ground[i] - c) * t);
      }
      const cosToSun = x * sun[0] + y * sun[1] + z * sun[2];
      const glow = Math.pow(Math.max(cosToSun, 0), 64) * 2;
      const disk = cosToSun > sunCos ? 2000 : 0;
      const o = (row * width + col) * 4;
      data[o] = color[0] + glow + disk;
      data[o + 1] = color[1] + glow * 0.9 + disk * 0.95;
      data[o + 2] = color[2] + glow * 0.75 + disk * 0.85;
      data[o + 3] = 1;
    }
  }
  return { data, width, height };
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
