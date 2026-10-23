import { describe, expect, it } from 'vitest';
import { DEFAULT_SKY_TIME, createSkyAt, sunPosition } from '../src/engine/sky';
import { readURLSettings } from '../src/urlSettings';

const W = 128, H = 64;
const pixel = (data: Float32Array, row: number, col: number) => Array.from(data.subarray((row * W + col) * 4, (row * W + col) * 4 + 3));
const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mean = (data: Float32Array, rows: [number, number]) => {
  let sum = 0;
  for (let row = rows[0]; row < rows[1]; row++) for (let col = 0; col < W; col++) sum += luminance(pixel(data, row, col));
  return sum / ((rows[1] - rows[0]) * W);
};
/** Texel of a direction in the map's convention: v = 0 is +Y, u follows atan2(-z, -x). */
const texel = (elevation: number, azimuth: number) => {
  const e = (elevation * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
  const x = Math.cos(e) * Math.cos(a), z = Math.cos(e) * Math.sin(a);
  const u = (Math.atan2(-z, -x) / (2 * Math.PI) + 1) % 1;
  return [Math.floor((0.5 - elevation / 180) * H), Math.floor(u * W)] as const;
};

describe('procedural sky', () => {
  it('keeps the default sun and follows the day from east to west', () => {
    expect(sunPosition(DEFAULT_SKY_TIME).elevation).toBeCloseTo(32.8, 1);
    expect(sunPosition(DEFAULT_SKY_TIME).azimuth).toBeCloseTo(50, 6);
    expect(sunPosition(12).elevation).toBeCloseTo(50, 6);
    expect(sunPosition(6).elevation).toBeCloseTo(0, 6);
    expect(sunPosition(9).azimuth).toBeLessThan(sunPosition(12).azimuth);
    expect(sunPosition(12).azimuth).toBeLessThan(sunPosition(15).azimuth);
  });

  it('places the sun disk, a blue zenith and a lit ground', () => {
    const { data, width, height } = createSkyAt(DEFAULT_SKY_TIME, W, H);
    expect([width, height]).toEqual([W, H]);
    let brightest = 0, at = 0;
    for (let i = 0; i < W * H; i++) if (data[i * 4] > brightest) [brightest, at] = [data[i * 4], i];
    const { elevation, azimuth } = sunPosition(DEFAULT_SKY_TIME);
    const [row, col] = texel(elevation, azimuth);
    expect(Math.abs(Math.floor(at / W) - row)).toBeLessThanOrEqual(1);
    expect(Math.min(Math.abs((at % W) - col), W - Math.abs((at % W) - col))).toBeLessThanOrEqual(1);
    const [r, , b] = pixel(data, 0, 0);
    expect(b).toBeGreaterThan(2 * r);
    expect(mean(data, [H / 2 + 4, H])).toBeGreaterThan(0.05);
    for (let i = 3; i < data.length; i += 4) expect(data[i]).toBe(1);
  });

  it('dims and reddens the light toward sunset', () => {
    const midday = createSkyAt(13, W, H).data, sunset = createSkyAt(18.25, W, H).data;
    expect(mean(sunset, [0, H])).toBeLessThan(0.2 * mean(midday, [0, H]));
    const { azimuth } = sunPosition(18);
    const [, col] = texel(0, azimuth);
    const [r, , b] = pixel(sunset, H / 2 - 1, col);
    expect(r).toBeGreaterThan(b);
  });

  it('reads the time of day from links within the day', () => {
    expect(readURLSettings('', '#skyTime=17.5')).toEqual({ skyTime: 17.5 });
    expect(readURLSettings('', '#skyTime=23')).toEqual({});
  });
});
