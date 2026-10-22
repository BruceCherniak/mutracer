import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {spawnCompiler} from '../scripts/compiler.mjs';
import {archiveName,cCompiler,cLinkFlags,executable} from '../scripts/platform.mjs';
import {compareStorageBytes} from './storage-comparison.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '.native-build/storage-typed'));
mkdirSync(out, {recursive:true});
const profile = resolve(out, 'profile.json'), archive = resolve(out, archiveName('storage')), host = resolve(out, executable('storage-host'));
writeFileSync(profile, JSON.stringify({profile_format:1, name:'storage_typed', entry:resolve(root, 'native/tests/storage-typed.ts'), emission:'llvm',
  abi:{prefix:'mt_module_', init_symbol:'mt_module_init', collect_symbol:'mt_module_collect', result_reset_symbol:'mt_module_reset', sink_register_symbol:'mt_module_sink', localize_runtime:true},
  exports:[{export:'storageParameters', symbol:'mt_module_run', params:['bytes'], returns:'bytes'}]}));
const built = spawnCompiler(process.env.MUTRACER_SCRIPTC ?? 'scriptc', ['build', '--lib', '--profile', profile, '-o', archive],
  {cwd:root, encoding:'utf8', maxBuffer:32*1024*1024}, true);
writeFileSync(resolve(out, 'build.log'), (built.stdout ?? '') + (built.stderr ?? ''));
if (built.status !== 0) throw new Error('Concrete storage compilation failed; see build.log');
const cc = spawnSync(cCompiler, ['-Wall', '-Wextra', '-Werror', resolve(root, 'native/tests/module-host.c'), archive, ...cLinkFlags, '-o', host], {encoding:'utf8'});
if (cc.status !== 0) throw new Error(cc.stderr);
const reference = resolve(out, 'reference.mjs');
await build({entryPoints:[resolve(root, 'native/tests/storage-typed.ts')], outfile:reference, bundle:true, platform:'node', format:'esm'});
const {storageParameters} = await import(pathToFileURL(reference));
const cases = [];
for (let storage = 0; storage < 4; storage++) for (let target = 0; target < 2; target++) for (let floating = 0; floating < 2; floating++) for (let flip = 0; flip < 2; flip++) for (const [width, height] of [[1, 1], [3, 2], [5, 4]]) {
  const values = new Float64Array(24);
  const samples = [0, .5, 1, 2, 3, 15, 31, 63, 127, 128, 200, 255, 256, 300, 65504, 2 ** -24];
  for (let i = 0; i < values.length; i++) values[i] = samples[i % samples.length];
  const bytes = new Uint8Array(32 + values.byteLength);new Uint32Array(bytes.buffer, 0, 8).set([storage, target, floating, flip, 3, 2, width, height]);bytes.set(new Uint8Array(values.buffer), 32);
  const prefix = resolve(out, String(cases.length)), expected = Buffer.from(storageParameters(bytes));
  writeFileSync(prefix + '.input', bytes);
  const run = spawnSync(host, [prefix + '.input', prefix + '.output'], {encoding:'utf8'});
  if (run.status !== 0) throw new Error(`C storage consumer: ${run.stderr}`);
  const actual = readFileSync(prefix + '.output'), comparison = compareStorageBytes(actual, expected);
  cases.push({storage, target, floating, flip, width, height, exact: comparison.byteIdentical,
    matched: comparison.matched, powerUlps: comparison.powerUlps});
  if (!comparison.matched) {writeFileSync(prefix + '.expected', expected);throw new Error(`Storage case ${cases.length - 1} differs`);}
}
writeFileSync(resolve(out, 'results.json'), JSON.stringify(cases, null, 2));
const rounded = cases.filter(result => !result.exact).length;
console.log(`PASS ${cases.length} storage cases/${cases.length * 2} C calls: four formats, byte/half targets, subarrays, resizing, orientation and environment CDF byte-exact; environment power ${rounded ? `${rounded} cases within 1 ULP (Windows libm)` : 'byte-exact'}.`);
