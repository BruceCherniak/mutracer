// Explicit real-window C consumer gate. The AppKit glue is separate from C code.
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [library, scene, output] = process.argv.slice(2);
if (!library || !scene || !output) throw Error('Usage: node native/scripts/window-host.mjs LIBRARY SCENE OUTPUT');
if (process.platform !== 'darwin') throw Error('This window consumer requires AppKit; other C surface platforms are runtime-unverified.');
const out = resolve(output);
mkdirSync(out, {recursive: true});
const executable = resolve(out, 'window-host');
function run(name, command, args) {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8', timeout: 60000});
  writeFileSync(resolve(out, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw result.error ?? Error(`${name} failed; see ${out}/${name}.log`);
}
run('build', 'clang', ['-std=c11', '-I', 'native/include', 'native/examples/window-host.c',
  'native/examples/window-appkit.m', '-framework', 'AppKit', '-framework', 'QuartzCore',
  resolve(library), '-Wl,-rpath,' + dirname(resolve(library)), '-o', executable]);
run('window', executable, [resolve(scene)]);
writeFileSync(resolve(out, 'summary.json'), JSON.stringify({passed: true, platform: process.platform,
  checks: ['real C presentation', 'suspend/resize', 'detach/reattach', 'clear/reload', 'diagnostics', 'custom callback/release']}, null, 2) + '\n');
console.log(`C window consumer passed; ${out}`);
