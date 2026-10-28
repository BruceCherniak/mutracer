import { describe, expect, it } from 'vitest';
import { DEFAULT_SKY_TIME, sunPosition } from '../src/engine/sky';
import { readURLSettings } from '../src/urlSettings';

describe('procedural sky', () => {
  it('keeps the default sun and follows the day from east to west', () => {
    expect(sunPosition(DEFAULT_SKY_TIME).elevation).toBeCloseTo(32.8, 1);
    expect(sunPosition(DEFAULT_SKY_TIME).azimuth).toBeCloseTo(50, 6);
    expect(sunPosition(12).elevation).toBeCloseTo(50, 6);
    expect(sunPosition(6).elevation).toBeCloseTo(0, 6);
    expect(sunPosition(9).azimuth).toBeLessThan(sunPosition(12).azimuth);
    expect(sunPosition(12).azimuth).toBeLessThan(sunPosition(15).azimuth);
  });

  it('reads the time of day from links within the day', () => {
    expect(readURLSettings('', '#skyTime=17.5')).toEqual({ skyTime: 17.5 });
    expect(readURLSettings('', '#skyTime=23')).toEqual({});
  });
});
