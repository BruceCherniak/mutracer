import { Texture } from '@meimu/mutracer';

export interface SkyOptions {
  width?: number;
  height?: number;
  /** Sun elevation above the horizon, in degrees. */
  sunElevation?: number;
  /** Sun azimuth around +Y, in degrees. */
  sunAzimuth?: number;
  /** Radiance of the sun disk. */
  sunIntensity?: number;
}

/**
 * Creates an equirectangular HDR sky: a zenith-to-horizon gradient, a darker
 * ground and a small, bright sun. Procedural, so the examples need no
 * environment-map download.
 */
export function createSkyTexture({
  width = 1024,
  height = 512,
  sunElevation = 35,
  sunAzimuth = 40,
  sunIntensity = 2000
}: SkyOptions = {}) {
  const data = new Float32Array(width * height * 4);
  const elevation = (sunElevation * Math.PI) / 180;
  const azimuth = (sunAzimuth * Math.PI) / 180;
  const sun = [
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth)
  ];
  const sunCos = Math.cos((0.6 * Math.PI) / 180);
  const zenith = [0.18, 0.36, 0.78];
  const horizon = [0.85, 0.85, 0.82];
  const ground = [0.16, 0.15, 0.14];

  for (let row = 0; row < height; row++) {
    // MuTracer maps v = 0 to +Y and u to atan2(-z, -x).
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
      const disk = cosToSun > sunCos ? sunIntensity : 0;
      const offset = (row * width + col) * 4;
      data[offset] = color[0] + glow + disk;
      data[offset + 1] = color[1] + glow * 0.9 + disk * 0.95;
      data[offset + 2] = color[2] + glow * 0.75 + disk * 0.85;
      data[offset + 3] = 1;
    }
  }
  return new Texture({ data, width, height });
}
