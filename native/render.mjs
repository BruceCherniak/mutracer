import {spawnCompiler} from './compiler.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build');
const compiler = process.env.MUTRACER_SCRIPTC ?? 'scriptc';
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(output, 'cargo-target'));
const samples = Number(process.env.MUTRACER_NATIVE_SAMPLES ?? '64');
if (!Number.isInteger(samples) || samples < 1 || samples > 4096) throw new Error('Samples must be 1..4096');
if (process.platform !== 'darwin') throw new Error('This first probe is configured and verified for macOS/Metal.');
mkdirSync(output, { recursive: true });
const env = { ...process.env, MUTRACER_NATIVE_OUTPUT: output, CARGO_TARGET_DIR: target,
  MUTRACER_AOT_ARCHIVE: resolve(output, 'render-core.lib.a') };
function run(name, command, args) {
  console.log(`${name}...`);
  const result = (command === compiler ? spawnCompiler : spawnSync)(command, args, { cwd: root, env, encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
  writeFileSync(resolve(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const version = run('compiler-version', compiler, ['--version']);
if (!/^0\.3\.2\s*$/.test(version)) throw new Error('This probe requires scriptc 0.3.2');
// All steps run serially. No source-level renderer refactor is needed to replay.
run('javascript-build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:lib']);
run('prepare-scene', process.execPath, ['native/prepare-scene.mjs']);
run('aot-build', compiler, ['build', '--lib', '--profile', 'native/render-core-profile.json',
  '-o', env.MUTRACER_AOT_ARCHIVE]);
run('native-build', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'native/host/Cargo.toml']);
const executable = resolve(output, 'render-host');
run('c-host-build', process.env.CC ?? 'cc', ['-Wall', '-Wextra', '-Werror', 'native/render-host.c',
  '-L', resolve(target, 'release'), '-lmutracer_native_probe',
  `-Wl,-rpath,${resolve(target, 'release')}`, '-o', executable]);
run('native-render', executable, [resolve(output, 'scene'), resolve(output, 'image'), String(samples), 'repeat']);
console.log(`Native render: ${resolve(output, 'image/render.png')}`);
console.log('Scope: original MuTracer shaders + native GPU + AOT BVH/sampling/frame/camera modules; scene/TLAS/material/shader preparation remains build-time JavaScript.');
