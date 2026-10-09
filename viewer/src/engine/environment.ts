import * as THREE from 'three';
import { parseRGBE } from 'claypt';
import { fetchWithProgress } from './fetchWithProgress';

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

export async function loadHDR(url: string, onProgress?: (loaded: number, total: number) => void) {
  return parseHDR(await fetchWithProgress(url, onProgress));
}

/**
 * Owns the environment DataTexture. ClayPT's EnvironmentLight has no intensity
 * or rotation, so both are baked into a copy of the source pixels; the scene
 * sync refreshes the ClayPT texture in place after `needsUpdate`.
 */
export class Environment {
  texture: THREE.DataTexture;
  private source: EquirectData;
  private intensity = 1;
  private rotation = 0;

  constructor(source: EquirectData) {
    this.source = source;
    this.texture = this.createTexture(source);
    this.bake();
  }

  private createTexture(source: EquirectData) {
    const texture = new THREE.DataTexture(
      new Float32Array(source.data.length), source.width, source.height, THREE.RGBAFormat, THREE.FloatType
    );
    texture.mapping = THREE.EquirectangularReflectionMapping;
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
    this.bake();
  }

  set(intensity: number, rotationDegrees: number) {
    if (intensity === this.intensity && rotationDegrees === this.rotation) return;
    this.intensity = intensity;
    this.rotation = rotationDegrees;
    this.bake();
  }

  private bake() {
    const { data: src, width, height } = this.source;
    const dst = (this.texture.image as EquirectData).data;
    const shift = Math.round((((this.rotation % 360) + 360) % 360) / 360 * width) % width;
    const k = this.intensity;
    for (let row = 0; row < height; row++) {
      const rowOffset = row * width;
      for (let col = 0; col < width; col++) {
        const s = (rowOffset + ((col + shift) % width)) * 4;
        const d = (rowOffset + col) * 4;
        dst[d] = src[s] * k;
        dst[d + 1] = src[s + 1] * k;
        dst[d + 2] = src[s + 2] * k;
        dst[d + 3] = 1;
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}
