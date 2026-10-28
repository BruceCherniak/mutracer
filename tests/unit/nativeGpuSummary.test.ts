import {describe, expect, it} from 'vitest';
import {gpuValidationCoverage} from '../../native/scripts/ci-gpu-summary.mjs';

const oracle = {passed: 581, skipped: 0};
const rust = {knownOpenHwrtFailures: 0};
const hosts = (differences: number[]) => ({
 complete: true,
 results: differences.map((hardwareDifferences, backend) => ({backend, hardwareDifferences})),
});

describe('native CI GPU coverage summary', () => {
 it('invalidates coverage for C host differences even when all other GPU checks pass', () => {
  const report = hosts([0, 1, 0, 0, 0, 1, 0, 0]);
  const original = structuredClone(report);
  expect(gpuValidationCoverage(oracle, rust, report)).toEqual({
   validated: false,
   cHosts: {cases: 8, hardwareDifferences: 2},
   reason: '2 C host HWRT image mismatches; review failures before release',
  });
  expect(report).toEqual(original);
 });

 it('accepts zero C differences and preserves GPU runs without the C hosts stage', () => {
  expect(gpuValidationCoverage(oracle, rust, hosts([0, 0]))).toEqual({
   validated: true, cHosts: {cases: 2, hardwareDifferences: 0},
  });
  expect(gpuValidationCoverage(oracle, rust)).toEqual({validated: true});
 });

 it.each([
  [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1],
 ])('retains every failure source (oracle %i, Rust %i, C %i)', (skipped, knownOpenHwrtFailures, hardwareDifferences) => {
  const result = gpuValidationCoverage({passed: 580, skipped}, {knownOpenHwrtFailures}, hosts([hardwareDifferences]));
  expect(result.validated).toBe(false);
  expect(result.reason).toBeDefined();
  const reason = result.reason ?? '';
  expect(reason.includes('full-reference renders failed')).toBe(skipped > 0);
  expect(reason.includes('known-open Metal HWRT image mismatches')).toBe(knownOpenHwrtFailures > 0);
  expect(reason.includes('C host HWRT image mismatches')).toBe(hardwareDifferences > 0);
 });

 it.each([
  null, {}, {complete: false, results: [{hardwareDifferences: 0}]},
  {complete: true, results: []}, {complete: true, results: [null]},
  {complete: true, results: [{}]}, hosts([-1]), hosts([0.5]), hosts([NaN]),
  hosts([Number.MAX_SAFE_INTEGER, 1]),
 ])('rejects malformed or incomplete C reports instead of claiming validation: %j', report => {
  expect(() => gpuValidationCoverage(oracle, rust, report)).toThrow(/C host/);
 });
});
