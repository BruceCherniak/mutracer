import {describe, expect, it} from 'vitest';
import {compareStorageBytes} from '../../native/validation/storage-comparison.mjs';

function packet(power = 1.897336967932097) {
  const bytes = Buffer.alloc(40);
  bytes.writeUInt32LE(8, 0); // Atlas byte length.
  bytes.writeUInt32LE(8, 4); // CDF byte length.
  bytes.set([0, 31, 128, 255, 17, 63, 127, 200], 16);
  bytes.writeFloatLE(1, 28);
  bytes.writeDoubleLE(power, 32);
  return bytes;
}

describe('native typed-storage byte contracts', () => {
  it('reports the measured Windows environment-power rounding without claiming byte identity', () => {
    const expected = packet(), actual = packet(1.8973369679320973);
    expect(compareStorageBytes(actual, expected, 'win32')).toEqual({matched: true, byteIdentical: false, powerUlps: 1});
    expect(compareStorageBytes(expected, actual, 'win32')).toEqual({matched: true, byteIdentical: false, powerUlps: 1});
    for (const platform of ['darwin', 'linux']) expect(compareStorageBytes(actual, expected, platform).matched).toBe(false);
  });

  it('keeps headers, atlas bytes, half encodings and every CDF bit exact', () => {
    const expected = packet();
    for (const offset of [0, 4, 8, 12, 16, 17, 23, 24, 28]) {
      const actual = packet(1.8973369679320973);
      actual[offset] ^= 1;
      expect(compareStorageBytes(actual, expected, 'win32').matched, `byte ${offset}`).toBe(false);
    }
  });

  it('rejects larger power errors, sign changes, nonfinite values and zero-to-subnormal changes', () => {
    const expected = packet(), actual = packet();
    actual.writeBigUInt64LE(expected.readBigUInt64LE(32) + 2n, 32);
    expect(compareStorageBytes(actual, expected, 'win32').matched).toBe(false);
    for (const value of [NaN, Infinity, -Infinity, -1.897336967932097, 0]) {
      expect(compareStorageBytes(packet(value), expected, 'win32').matched).toBe(false);
    }
    expect(compareStorageBytes(packet(Number.MIN_VALUE), packet(0), 'win32').matched).toBe(false);
    expect(compareStorageBytes(packet(NaN), packet(NaN), 'win32').matched).toBe(false);
  });

  it('requires the complete packet layout and preserves exact matches on every platform', () => {
    const expected = packet();
    for (const actual of [expected.subarray(0, 39), Buffer.concat([expected, Buffer.alloc(1)])]) {
      expect(compareStorageBytes(actual, expected, 'win32').matched).toBe(false);
    }
    expect(compareStorageBytes(Buffer.alloc(8), Buffer.alloc(8), 'win32').matched).toBe(false);
    const malformed = packet(); malformed.writeUInt32LE(12, 0);
    expect(compareStorageBytes(malformed, malformed, 'win32').matched).toBe(false);
    for (const platform of ['win32', 'darwin', 'linux']) for (const power of [0, 1.897336967932097]) {
      expect(compareStorageBytes(packet(power), packet(power), platform)).toEqual({matched: true, byteIdentical: true, powerUlps: 0});
    }
  });
});
