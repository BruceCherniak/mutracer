import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build');
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(output, 'cargo-target'));
if (process.platform !== 'darwin') throw new Error('The first native verification targets macOS/Metal.');
mkdirSync(output, { recursive: true });
function run(name, executable, args, extraEnv = {}) {
  console.log(`${name}...`);
  const result = spawnSync(executable, args, { cwd: root, env: { ...process.env, ...extraEnv }, encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  writeFileSync(resolve(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed. See ${resolve(output, `${name}.log`)}`);
  return result.stdout;
}
// Build via native:render first. This verifier runs all cases serially.
const host = resolve(output, 'input-host');
run('input-host-build', process.env.CC ?? 'cc', ['-Wall', '-Wextra', '-Werror', 'native/input-host.c',
  '-L', resolve(target, 'release'), '-lmutracer_native_probe',
  `-Wl,-rpath,${resolve(target, 'release')}`, '-o', host]);
const inputs = JSON.parse(run('native-input-verification', host, [resolve(output, 'scene'), resolve(output, 'variants')]));
run('ray-query-verification', resolve(target, 'release/ray-query-probe'), [resolve(output, 'ray-query')]);
const rayQuery = JSON.parse(readFileSync(resolve(output, 'ray-query/result.json'), 'utf8'));
function verifyBvh(sceneDirectory, imageDirectory) {
  const scene = JSON.parse(readFileSync(resolve(sceneDirectory, 'scene.json'), 'utf8'));
  const result = JSON.parse(readFileSync(resolve(imageDirectory, 'result.json'), 'utf8'));
  if (!scene.nativeBvh || !result.nativeBvh?.geometries || !result.nativeSamplingModule) {
    throw new Error('Composed native BVH/sampling modules were not used');
  }
  const reference = scene.buffers.find(buffer => buffer.id === scene.nativeBvh.buffer);
  if (!readFileSync(resolve(sceneDirectory, reference.file)).equals(readFileSync(resolve(imageDirectory, 'native-bvh.bin')))) {
    throw new Error('Native BVH bytes differ from the original builder');
  }
  return { ...result.nativeBvh, byteIdentical: true };
}
const composition = { baseline: verifyBvh(resolve(output, 'scene'), resolve(output, 'variants/baseline')) };
// Preserve the software raw-geometry gate after removing archived hybrid replay.
const rawOnly = resolve(output, 'raw-geometry-only');
rmSync(rawOnly, { recursive: true, force: true });
cpSync(resolve(output, 'scene'), resolve(rawOnly, 'scene'), { recursive: true });
const rawScene = JSON.parse(readFileSync(resolve(rawOnly, 'scene/scene.json'), 'utf8'));
const packedBvh = rawScene.buffers.find(buffer => buffer.id === rawScene.nativeBvh.buffer);
rmSync(resolve(rawOnly, 'scene', packedBvh.file));
run('raw-geometry-only-render', resolve(target, 'release/mutracer-native-probe'),
  [resolve(rawOnly, 'scene'), resolve(rawOnly, 'image'), '256']);
for (const name of ['render', 'normal', 'albedo', 'native-bvh']) {
  const file = name === 'native-bvh' ? `${name}.bin` : `${name}.rgba32f`;
  if (!readFileSync(resolve(rawOnly, 'image', file)).equals(readFileSync(resolve(output, 'variants/baseline', file))))
    throw new Error(`Render without prebuilt BVH differs: ${name}`);
}
composition.withoutPrebuiltBvh = true;
writeFileSync(resolve(output, 'verification.json'), JSON.stringify({inputs, rayQuery, composition}, null, 2) + '\n');
console.log('Native software replay and independent ray-query contracts passed; raw HWRT uses the scene gates.');
