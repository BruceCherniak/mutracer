import {describe, expect, it} from 'vitest';
import {compareModuleBytes} from '../../native/validation/module-comparison.mjs';

function sphere() {
  const bytes = Buffer.alloc(100);
  bytes.writeUInt32LE(3, 16); // Positions.
  bytes.writeUInt32LE(3, 20); // Normals.
  bytes.writeFloatLE(6.123234262925839e-17, 64);
  bytes.writeUInt32LE(1, 88); // An index, outside the floating-point ranges.
  return bytes;
}

describe('native module byte contracts', () => {
  it('reports the Windows libm residual without claiming byte identity', () => {
    const expected = sphere(), actual = Buffer.from(expected);
    actual.writeFloatLE(6.123031769111886e-17, 64);
    expect(compareModuleBytes('geometry', actual, expected, 'win32')).toEqual({matched:true, byteIdentical:false, nearZeroComponents:1});
    expect(compareModuleBytes('geometry', actual, expected, 'linux').matched).toBe(false);
    expect(compareModuleBytes('bvh-facade', actual, expected, 'win32').matched).toBe(false);
  });

  it('keeps headers, indices, lengths and ordinary coordinates exact', () => {
    const expected = sphere();
    for (const offset of [0, 88]) {
      const actual = Buffer.from(expected); actual.writeUInt32LE(2, offset);
      expect(compareModuleBytes('geometry', actual, expected, 'win32').matched).toBe(false);
    }
    expect(compareModuleBytes('geometry', expected.subarray(4), expected, 'win32').matched).toBe(false);
    const actual = Buffer.from(expected); actual.writeFloatLE(1, 64);
    const ordinary = Buffer.from(expected); ordinary.writeFloatLE(1 + 2 ** -23, 64);
    expect(compareModuleBytes('geometry', actual, ordinary, 'win32').matched).toBe(false);
  });

  it('rejects larger residuals, nonfinite values and sign changes', () => {
    const expected = sphere();
    for (const value of [6.13e-17, NaN, Infinity, -6.123234262925839e-17]) {
      const actual = Buffer.from(expected); actual.writeFloatLE(value, 64);
      expect(compareModuleBytes('geometry', actual, expected, 'win32').matched).toBe(false);
    }
    expect(compareModuleBytes('geometry', expected, expected, 'win32')).toEqual({matched:true, byteIdentical:true, nearZeroComponents:0});
  });
});
