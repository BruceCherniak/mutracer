import { describe, expect, it } from 'vitest';
import { summarizeCoverage } from '../../native/validation/diagnostics.mjs';

const report = (groups: object[], success = true) => ({
  schema: 'scriptc-diagnostics', schemaVersion: 1, success, phase: 'compile', groups
});

describe('native library coverage gate', () => {
  it('rejects errors in exported functions even when coverage reports success', () => {
    const result = summarizeCoverage(report([
      { code: 'SC1090', severity: 'error', scope: 'unreached', count: 2 }
    ]), 0);
    expect(result.passed).toBe(false);
    expect(result.errorSites).toBe(2);
    expect(result.unreachedErrorGroups).toBe(1);
  });

  it('requires both clean diagnostics and a successful compiler exit', () => {
    expect(summarizeCoverage(report([]), 0).passed).toBe(true);
    expect(summarizeCoverage(report([]), 1).passed).toBe(false);
    expect(summarizeCoverage(report([], false), 0).passed).toBe(false);
    expect(summarizeCoverage(report([
      { code: 'W1', severity: 'warning', scope: 'reached', count: 1 }
    ]), 0).passed).toBe(true);
  });

  it('fails closed when diagnostics cannot be interpreted', () => {
    expect(() => summarizeCoverage({ success: true }, 0)).toThrow();
    expect(() => summarizeCoverage(report([
      { code: 'SC1090', severity: 'error', scope: 'reached' }
    ]), 0)).toThrow();
  });
});
