import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {vec2, vec3} from 'gl-matrix';
import {spawnCompiler} from './compiler.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '.native-build/vector-typed'));
mkdirSync(out, {recursive:true});
const profile = resolve(out, 'profile.json'), archive = resolve(out, 'vector.lib.a'), host = resolve(out, 'vector-host');
writeFileSync(profile, JSON.stringify({profile_format:1, name:'vector_typed', entry:resolve(root, 'native/tests/vector-typed.ts'), emission:'llvm',
  abi:{prefix:'mt_module_', init_symbol:'mt_module_init', collect_symbol:'mt_module_collect', result_reset_symbol:'mt_module_reset', sink_register_symbol:'mt_module_sink', localize_runtime:true},
  exports:[{export:'vectorParameters', symbol:'mt_module_run', params:['bytes'], returns:'bytes'}]}));
const built = spawnCompiler(process.env.MUTRACER_SCRIPTC ?? 'scriptc', ['build', '--lib', '--profile', profile, '-o', archive],
  {cwd:root, encoding:'utf8', maxBuffer:32*1024*1024}, true);
writeFileSync(resolve(out, 'build.log'), (built.stdout ?? '') + (built.stderr ?? ''));
if (built.status !== 0) throw new Error('Concrete vector compilation failed; see build.log');
const summary = JSON.parse(readFileSync(resolve(built.nativeSourceRoot, 'vector-specialization.json'), 'utf8'));
if (!summary.functions) throw new Error('No concrete vector kernels exercised');
const cc = spawnSync(process.env.CC ?? 'cc', ['-Wall', '-Wextra', '-Werror', resolve(root, 'native/module-host.c'), archive, '-lm', '-o', host], {encoding:'utf8'});
if (cc.status !== 0) throw new Error(cc.stderr);
let seed = 0x7521;
function random() {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;}
const results = [];
for (let i = 0; i < 100; i++) {
  const input = new Float64Array(6);
  for (let k = 0; k < 6; k++) input[k] = i ? (random()-.5)*10 ** (i % 9) : 0;
  const a = input.slice(0, 3), b = new Float32Array(input.slice(3, 6)), f = new Float32Array(a), alias = f.subarray(0, 3);
  const expected = new Float64Array(37);
  expected.set(vec3.normalize(new Float32Array(3), f), 0);
  expected.set(vec3.cross(alias, alias, b), 3);
  expected.set(vec3.sub(new Float64Array(3), a, b), 6);
  expected.set(vec3.min(new Float64Array(3), a, b), 9);
  expected.set(vec3.max(new Float32Array(3), b, a), 12);
  expected.set(vec3.lerp(new Float32Array(3), a, b, .25), 15);
  expected.set(vec3.scaleAndAdd(a, a, b, .125), 18);
  expected.set(vec3.copy(new Float64Array(3), b), 21);
  expected.set(vec3.set(new Float32Array(3), input[0], input[1], input[2]), 24);
  const xy = new Float32Array(input.slice(0, 2)); expected.set(vec2.normalize(xy, xy), 27);
  expected[29] = vec3.len(b); expected[30] = vec3.dist(a, b);
  const ordinary = Array.from(input.slice(3, 6)); vec3.normalize(ordinary, ordinary); expected.set(ordinary, 31);
  expected.set(vec3.scale(new Float64Array(3), b, .75), 34);
  const path = resolve(out, String(i)); writeFileSync(path + '.input', new Uint8Array(input.buffer));
  const run = spawnSync(host, [path + '.input', path + '.output'], {encoding:'utf8'});
  if (run.status !== 0) throw new Error(`C vector consumer ${i}: ${run.stderr}`);
  const exact = readFileSync(path + '.output').equals(Buffer.from(expected.buffer));
  results.push({index:i, exact}); if (!exact) throw new Error(`Concrete vector ${i} differs from upstream reference`);
}
writeFileSync(resolve(out, 'results.json'), JSON.stringify({summary, results}, null, 2));
console.log('PASS 100 concrete vector cases/200 C calls: mixed Float32/Float64, in-place/subarray aliasing, ordinary-array fallback and zero vectors equal upstream gl-matrix.');
