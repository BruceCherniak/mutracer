import { describe, expect, it } from 'vitest';
import {
  getOpenPbrEnergyLutData,
  OPENPBR_ENERGY_LUT_AVERAGE_ROW,
  OPENPBR_ENERGY_LUT_HEIGHT,
  OPENPBR_ENERGY_LUT_WIDTH,
  OPENPBR_METAL_ENERGY_LUT_ROW,
  OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW
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
    expect(Math.abs(data[OPENPBR_METAL_ENERGY_LUT_ROW * 32 - 1]! - 60821 / 65535)).toBeLessThanOrEqual(0.002);
  });
});

// Integrate the analytic unit-Fresnel GGX BRDF independently of table encoding.
// This checks the complement's semantics and axis order, not just source anchors.
function idealMetalEnergy(roughness: number, viewCosine: number): number {
  const alpha = roughness * roughness;
  const viewX = Math.sqrt(1 - viewCosine * viewCosine);
  const g1 = (mu: number) => 2 / (1 + Math.sqrt(1 + alpha * alpha * (1 - mu * mu) / (mu * mu)));
  const steps = 512;
  let integral = 0;
  for (let y = 0; y < steps; y++) {
    const mu = (y + .5) / steps;
    const radial = Math.sqrt(1 - mu * mu);
    const masking = g1(viewCosine) * g1(mu);
    for (let x = 0; x < steps; x++) {
      const phi = (x + .5) * 2 * Math.PI / steps;
      const dotVL = viewX * radial * Math.cos(phi) + viewCosine * mu;
      const halfZ = (viewCosine + mu) / Math.sqrt(2 + 2 * dotVL);
      const denom = 1 + halfZ * halfZ * (alpha * alpha - 1);
      const ndf = alpha * alpha / (Math.PI * denom * denom);
      integral += ndf * masking / (4 * viewCosine);
    }
  }
  return integral * 2 * Math.PI / (steps * steps);
}

function metalLoss(roughness: number, cosine: number): number {
  const data = getOpenPbrEnergyLutData();
  const r = roughness * 31, c = cosine * 31;
  const r0 = Math.floor(r), r1 = Math.min(31, r0 + 1);
  const c0 = Math.floor(c), c1 = Math.min(31, c0 + 1);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const row = (i: number) => mix(data[(OPENPBR_METAL_ENERGY_LUT_ROW + i) * 32 + c0]!, data[(OPENPBR_METAL_ENERGY_LUT_ROW + i) * 32 + c1]!, c - c0);
  return mix(row(r0), row(r1), r - r0);
}

describe('ideal-metal multiple-scattering table contract', () => {
  it.each([[.3, .9], [.6, .3], [.6, .9], [.9, .3]])('accounts for analytic GGX loss (roughness=%s, cosine=%s)', (roughness, cosine) => {
    expect(Math.abs(idealMetalEnergy(roughness!, cosine!) + metalLoss(roughness!, cosine!) - 1)).toBeLessThan(.0025);
  });

  it('preserves tiny average losses and their cosine-weighted normalization', () => {
    const data = getOpenPbrEnergyLutData();
    // These small u16 values would disappear if all 32 averages shared one
    // normalized row. Degenerate rows preserve them and keep the divisor finite.
    for (const [r, value] of [[2, 7], [3, 30], [31, 40831]]) {
      expect(data[(OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW + r!) * 32]!).toBeCloseTo(value! / 65535, 7);
    }
    for (const roughness of [.3, .6, .9]) {
      let average = 0;
      const n = 4096;
      for (let i = 0; i < n; i++) {
        const cosine = (i + .5) / n;
        average += 2 * cosine * metalLoss(roughness, cosine) / n;
      }
      const index = roughness * 31, i0 = Math.floor(index);
      const a = data[(OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW + i0) * 32]!;
      const b = data[(OPENPBR_METAL_ENERGY_LUT_AVERAGE_ROW + i0 + 1) * 32]!;
      expect(Math.abs(average - (a + (b - a) * (index - i0)))).toBeLessThan(.002);
    }
  });
});
