import {describe, expect, it} from 'vitest';
import {classifyHostGpuResult, hwrtLoopIterations} from '../../native/scripts/host-gpu-results.mjs';

const metal = {hardware: true, backend: 'Metal'};
const shared = 'api::tests::hardware_shared_scene_renders_match_fresh_l0_contexts';
const loop = 'api::tests::hardware_loop_against_fresh_l0_contexts';
const imageMismatch = 'restart: render 1: hdr differs at float Some(200): Some(2.5) vs Some(1.6666666)';
const loopMismatch = '2 HWRT image mismatches; see per-sample history above';
const failed = (test = shared, message = imageMismatch) => ({
 status: 101,
 output: `running 1 test
test ${test} ... FAILED

thread '${test}' (12345) panicked at src/api/tests.rs:530:9:
${message}
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 95 filtered out; finished in 8.34s
error: test failed, to rerun pass \`--lib\`
`,
});

describe('native host GPU failure gate', () => {
 it.each([
  [shared, imageMismatch],
  ['api::tests::hardware_renders_match_fresh_l0_contexts', imageMismatch],
  [loop, loopMismatch],
 ])('records only the known assertion in %s on hardware Metal', (test, message) => {
  expect(classifyHostGpuResult(test, failed(test, message), metal)).toEqual({
   status: 'known-open-hwrt-failure', failure: message,
  });
 });

 it.each([
  [loop, 'MT_LOOP_ITERATIONS must be positive'],
  [shared, 'no hardware ray queries'],
  [shared, 'called `Result::unwrap()` on an `Err` value: DeviceLost'],
  [shared, 'restart: render 1: hdr length'],
  [shared, loopMismatch],
  [loop, imageMismatch],
  ['api::tests::hardware_new_regression', imageMismatch],
  ['context::tests::another_test', imageMismatch],
 ])('fails %s for an unrelated or unlisted assertion: %s', (test, message) => {
  expect(classifyHostGpuResult(test, failed(test, message), metal).status).toBe('failed');
 });

 it.each([
  {hardware: true, backend: 'Vulkan'},
  {hardware: true, backend: 'Dx12'},
  {hardware: false, backend: 'Metal'},
 ])('does not exempt image mismatches on %j', gpu => {
  expect(classifyHostGpuResult(shared, failed(), gpu).status).toBe('failed');
 });

 it('requires a single matching test panic and a complete libtest failure report', () => {
  const result = failed();
  for (const output of [
   result.output.replace(`thread '${shared}'`, "thread 'another_test'"),
   result.output + "thread 'worker' panicked at src/context.rs:1:1:\nDeviceLost\n",
   result.output.replace('src/api/tests.rs', 'src/context.rs'),
   result.output.replace('test result: FAILED.', 'incomplete test result:'),
   result.output.replace('0 passed; 1 failed;', '1 passed; 1 failed;'),
  ]) expect(classifyHostGpuResult(shared, {...result, output}, metal).status).toBe('failed');
 });

 it('fails compiler errors, process errors, signals and unexpected exit codes', () => {
  const result = failed();
  for (const changed of [
   {status: 101, output: 'error[E0308]: mismatched types\nerror: could not compile crate'},
   {...result, error: Error('spawn cargo ENOENT')},
   {...result, signal: 'SIGKILL'},
   {...result, status: 1},
   {...result, status: null},
  ]) expect(classifyHostGpuResult(shared, changed, metal).status).toBe('failed');
 });

 it('accepts one passed test but rejects a zero-test or incomplete success', () => {
  const output = 'test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 95 filtered out; finished in 0.1s';
  expect(classifyHostGpuResult(shared, {status: 0, output}, metal)).toEqual({status: 'passed'});
  expect(classifyHostGpuResult(shared, {status: 0, output: output.replace('1 passed', '0 passed')}, metal).status).toBe('failed');
  expect(classifyHostGpuResult(shared, {status: 0, output: ''}, metal).status).toBe('failed');
 });

 it('recognizes CRLF libtest output from the same known assertion', () => {
  const result = failed();
  expect(classifyHostGpuResult(shared, {...result, output: result.output.replaceAll('\n', '\r\n')}, metal).status)
   .toBe('known-open-hwrt-failure');
 });
});

describe('native CI HWRT loop count', () => {
 it('defaults to 200 and accepts positive decimal safe integers', () => {
  expect(hwrtLoopIterations()).toBe(200);
  expect(hwrtLoopIterations('1')).toBe(1);
  expect(hwrtLoopIterations('2000')).toBe(2000);
 });

 it.each(['0', '-1', '', ' ', '200oops', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992'])
 ('rejects invalid configuration %j before running tests', value => {
  expect(() => hwrtLoopIterations(value)).toThrow('MT_LOOP_ITERATIONS must be a positive safe integer');
 });
});
