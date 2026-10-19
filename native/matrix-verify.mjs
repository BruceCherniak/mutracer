import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mat3, mat4, vec3} from 'gl-matrix';
import {spawnCompiler} from './compiler.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '.native-build/matrix-f64'));
mkdirSync(out, {recursive:true});
const profile = resolve(out, 'profile.json'), archive = resolve(out, 'matrix.lib.a'), host = resolve(out, 'matrix-host');
writeFileSync(profile, JSON.stringify({profile_format:1, name:'matrix_f64', entry:resolve(root, 'native/tests/matrix-f64.ts'), emission:'llvm',
  abi:{prefix:'mt_module_', init_symbol:'mt_module_init', collect_symbol:'mt_module_collect', result_reset_symbol:'mt_module_reset', sink_register_symbol:'mt_module_sink', localize_runtime:true},
  exports:[{export:'matrixParameters', symbol:'mt_module_run', params:['bytes'], returns:'bytes'}]}));
const built = spawnCompiler(process.env.MUTRACER_SCRIPTC ?? 'scriptc', ['build', '--lib', '--profile', profile, '-o', archive],
  {cwd:root, encoding:'utf8', maxBuffer:32*1024*1024}, true);
writeFileSync(resolve(out, 'build.log'), (built.stdout ?? '') + (built.stderr ?? ''));
if (built.status !== 0 || built.nativeMatrixPrecision !== 64) throw new Error('Float64 matrix compilation failed');
const cc = spawnSync(process.env.CC ?? 'cc', ['-Wall', '-Wextra', '-Werror', resolve(root, 'native/module-host.c'), archive, '-lm', '-o', host], {encoding:'utf8'});
if (cc.status !== 0) throw new Error(cc.stderr);
let seed = 0x1234;
function random() {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32;}
const results = [];
for (let i = 0; i < 100; i++) {
  const a = mat4.identity(new Float64Array(16)), b = mat4.identity(new Float64Array(16));
  if (!i) {a[12] = 2 ** 40 + .125; b[12] = .25;}
  else for (const m of [a, b]) {
    m[0] = .25 + random()*2; m[5] = .25 + random()*2; m[10] = .25 + random()*2;
    m[4] = random()*.2; m[8] = random()*.2; m[9] = random()*.2;
    m[12] = (random()-.5)*1e6 + .125; m[13] = (random()-.5)*100; m[14] = (random()-.5)*100;
  }
  const input = new Float64Array(32); input.set(a); input.set(b, 16);
  const product = mat4.multiply(new Float64Array(16), a, b), inverse = mat4.invert(new Float64Array(16), product);
  const point = vec3.transformMat4(new Float32Array(3), new Float32Array([.1, .2, .3]), product);
  const expected = new Float64Array(46); expected.set([8, 8]); expected.set(product, 2); expected.set(inverse, 18); expected.set(point, 34); expected.set(mat3.normalFromMat4(new Float64Array(9), product), 37);
  const path = resolve(out, String(i)); writeFileSync(path + '.input', new Uint8Array(input.buffer));
  const run = spawnSync(host, [path + '.input', path + '.output'], {encoding:'utf8'});
  if (run.status !== 0) throw new Error(`C matrix consumer ${i}: ${run.stderr}`);
  const actual = readFileSync(path + '.output'), exact = actual.equals(Buffer.from(expected.buffer));
  results.push({index:i, exact}); if (!exact) throw new Error(`Float64 matrix ${i} differs from upstream reference`);
}
writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2));
console.log('PASS 100 native Float64 matrix/vector cases, 200 C calls; explicit 8-byte matrices, inverse normal matrices and outputs equal the independent upstream reference.');
