// These three observations live on the engine-api branch. Only their known
// image-mismatch assertions on hardware Metal may be non-gating; a test name
// alone must never exempt compiler errors, device failures or other panics.
const imageMismatch = /^.+: (?:hdr|normal|albedo) differs at float Some\(\d+\): Some\([-+\d.eE]+\) vs Some\([-+\d.eE]+\)$/;
const knownAssertions = new Map([
 ['api::tests::hardware_renders_match_fresh_l0_contexts', imageMismatch],
 ['api::tests::hardware_shared_scene_renders_match_fresh_l0_contexts', imageMismatch],
 ['api::tests::hardware_loop_against_fresh_l0_contexts', /^[1-9]\d* HWRT image mismatches; see per-sample history above$/],
]);

export function hwrtLoopIterations(value = '200') {
 const iterations = Number(value);
 if (!/^\d+$/.test(value) || !Number.isSafeInteger(iterations) || iterations < 1)
  throw Error('MT_LOOP_ITERATIONS must be a positive safe integer.');
 return iterations;
}

export function classifyHostGpuResult(test, result, gpu) {
 const output = result.output ?? '';
 const panics = [...output.matchAll(/^thread [^\n]* panicked at /gm)];
 const panic = /^thread '([^'\n]+)'(?: \(\d+\))? panicked at [^\n]*[/\\]api[/\\]tests\.rs:\d+:\d+:\r?\n([^\r\n]+)/m.exec(output);
 if (!result.error && !result.signal && result.status === 0 &&
     /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured;/m.test(output))
  return {status: 'passed'};
 const failure = result.error?.message ?? (result.signal ? `signal ${result.signal}` :
  panic?.[2] ?? /panicked at [^\n]*\n([^\r\n]*)/.exec(output)?.[1] ?? `unexpected test result (exit ${result.status})`);
 const known = !result.error && !result.signal && result.status === 101 &&
  gpu.hardware === true && gpu.backend === 'Metal' &&
  panics.length === 1 && panic?.[1] === test && knownAssertions.get(test)?.test(panic[2]) &&
  /^test result: FAILED\. 0 passed; 1 failed; 0 ignored; 0 measured;/m.test(output);
 return {status: known ? 'known-open-hwrt-failure' : 'failed', failure};
}
