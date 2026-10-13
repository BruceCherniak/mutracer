import { describe, expect, it } from 'vitest';
import {
  getOpenPbrEnergyLutData,
  OPENPBR_ENERGY_LUT_AVERAGE_ROW,
  OPENPBR_ENERGY_LUT_HEIGHT,
  OPENPBR_ENERGY_LUT_WIDTH
} from '../../src/renderer/openPbrEnergyLut';

describe('OpenPBR opaque dielectric energy LUT', () => {
  it('decodes the complete Adobe 32^3 and 32^2 tables', () => {
    const data = getOpenPbrEnergyLutData();
    expect(data).toHaveLength(
      OPENPBR_ENERGY_LUT_WIDTH * OPENPBR_ENERGY_LUT_HEIGHT
    );
    expect(OPENPBR_ENERGY_LUT_AVERAGE_ROW).toBe(32 * 32);
    expect(Math.min(...data)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...data)).toBeLessThanOrEqual(1);
  });

  it('stays within 0.002 of representative Uint16 UNORM source values', () => {
    const data = getOpenPbrEnergyLutData();
    const averageOffset = OPENPBR_ENERGY_LUT_AVERAGE_ROW
      * OPENPBR_ENERGY_LUT_WIDTH;
    expect(Math.abs(data[29]! - 50582 / 65535)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(data[32 * 32 * 32 - 1]! - 61816 / 65535)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(data[averageOffset]! - 8159 / 65535)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(data.at(-1)! - 60821 / 65535)).toBeLessThanOrEqual(0.002);
  });
});
