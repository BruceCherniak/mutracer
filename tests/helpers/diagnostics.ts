import {expect} from 'vitest';

export function expectDataOnlyDiagnostics(value: unknown) {
  expect(value).toBeDefined();
  function visit(node: unknown) {
    expect(typeof node).not.toBe('function');
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) {
      expect(['displayParity', 'loadAccumulation']).not.toContain(key);
      visit(child);
    }
  }
  visit(value);
}
