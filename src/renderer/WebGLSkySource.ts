import type { EnvironmentMapSource, EnvironmentSource } from './envMapDistribution.js';
import { WebGLSkyBaker } from './WebGLSkyBaker.js';

/** CPU-backed compatibility path for WebGL environment uploads. */
export class WebGLSkySource {
  private baker?: WebGLSkyBaker;
  private readonly images = new WeakMap<EnvironmentSource, EnvironmentMapSource>();
  private sky?: { time: number; width: number; height: number; data: Float32Array };

  resolve(source: EnvironmentSource | undefined): EnvironmentMapSource | undefined {
    if (!source || !('sky' in source)) return source;
    const cached = this.images.get(source);
    if (cached) return cached;
    const { width, height, sky: { time }, intensity, ambient } = source;
    this.baker ??= new WebGLSkyBaker();
    if (!this.sky || this.sky.time !== time || this.sky.width !== width || this.sky.height !== height) {
      this.sky = { time, ...this.baker.bake(time, width, height) };
    }
    let data = this.sky.data;
    if (intensity !== 1 || ambient.some(value => value !== 0)) {
      data = data.map((value, index) => index % 4 === 3 ? value : value * intensity + ambient[index % 4]);
    }
    const result = { width, height, data };
    this.images.set(source, result);
    return result;
  }
  dispose() { this.baker?.dispose(); this.baker = undefined; this.sky = undefined; }
}
