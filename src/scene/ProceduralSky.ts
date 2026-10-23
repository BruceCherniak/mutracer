import Texture from './Texture.js';
import { DEFAULT_SKY_TIME, type ProceduralSkyImage } from './skyParameters.js';

/** Settings for a clear Earth sky, with local solar time on an equinox at latitude 40°. */
export interface ProceduralSkyOptions {
  /** Equirectangular pixel width and height, positive integers. Default `[2048, 1024]`.
   * Limited by the active device's maximum texture size; WebGPU lighting also needs 8 bytes per texel within its storage-binding limit. */
  resolution?: readonly [number, number];
  /** Local solar time in hours, from `0` to `24`. Default `15`. Night has no stars, moon or artificial light. */
  time?: number;
}

/**
 * Clear-sky HDR environment for EnvironmentLight.map and scene backgrounds.
 * Change time or resolution, then call engine.update(). WebGPU generates the
 * map directly on the rendering device; WebGL 2 requires float render targets
 * and reads the generated map back to CPU memory. Not a material texture.
 */
export default class ProceduralSky extends Texture {
  declare image: ProceduralSkyImage;

  constructor(options: ProceduralSkyOptions = {}) {
    const [width, height] = validResolution(options.resolution ?? [2048, 1024]);
    super({ type: 'ProceduralSky', width, height, time: validTime(options.time ?? DEFAULT_SKY_TIME) });
    this.colorSpace = 'linear';
  }

  /** Local solar time in hours, `0`–`24`. Default `15`; edits take effect on engine.update(). */
  get time() { return this.image.time; }
  set time(value: number) {
    const time = validTime(value);
    if (time !== this.time) this.image = { ...this.image, time };
  }

  /** Equirectangular pixel dimensions. Default `[2048, 1024]`; resizing discards accumulated samples. */
  get resolution(): readonly [number, number] { return [this.image.width, this.image.height]; }
  set resolution(value: readonly [number, number]) {
    const [width, height] = validResolution(value);
    if (width !== this.image.width || height !== this.image.height) this.image = { ...this.image, width, height };
  }
}

function validTime(time: number) {
  if (!Number.isFinite(time) || time < 0 || time > 24) throw new RangeError('ProceduralSky time must be between 0 and 24 hours.');
  return time;
}
function validResolution(value: readonly [number, number]) {
  if (value.length !== 2 || !value.every(size => Number.isSafeInteger(size) && size > 0)) {
    throw new RangeError('ProceduralSky resolution must contain two positive integers.');
  }
  return value;
}
