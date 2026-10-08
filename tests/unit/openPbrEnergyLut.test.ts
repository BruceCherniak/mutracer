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

  it('preserves representative Uint16 UNORM source values', () => {
    const data = getOpenPbrEnergyLutData();
    const averageOffset = OPENPBR_ENERGY_LUT_AVERAGE_ROW
      * OPENPBR_ENERGY_LUT_WIDTH;
    expect(data[29]).toBeCloseTo(50582 / 65535, 7);
    expect(data[32 * 32 * 32 - 1]).toBeCloseTo(61816 / 65535, 7);
    expect(data[averageOffset]).toBeCloseTo(8159 / 65535, 7);
    expect(data.at(-1)).toBeCloseTo(60821 / 65535, 7);
  });
});
