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
const hwrtHost = resolve(output, 'hwrt-host');
run('hwrt-host-build', process.env.CC ?? 'cc', ['-Wall', '-Wextra', '-Werror', 'native/hwrt-host.c',
  '-L', resolve(target, 'release'), '-lmutracer_native_probe',
  `-Wl,-rpath,${resolve(target, 'release')}`, '-o', hwrtHost]);
run('hybrid-hwrt-render', hwrtHost, [resolve(output, 'scene'), resolve(output, 'hardware-image')]);
const hardware = JSON.parse(readFileSync(resolve(output, 'hardware-image/result.json'), 'utf8'));
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
const composition = { baseline: verifyBvh(resolve(output, 'scene'), resolve(output, 'variants/baseline')),
  hardware: verifyBvh(resolve(output, 'scene'), resolve(output, 'hardware-image')) };
const comparison = JSON.parse(run('software-hardware-comparison', process.execPath, ['native/compare-hdr.mjs',
  resolve(output, 'variants/baseline/render.rgba32f'), resolve(output, 'hardware-image/render.rgba32f')]));
const aovs = {};
for (const name of ['normal', 'albedo']) {
  aovs[name] = JSON.parse(run(`software-hardware-${name}-comparison`, process.execPath, ['native/compare-hdr.mjs',
    resolve(output, `variants/baseline/${name}.rgba32f`), resolve(output, `hardware-image/${name}.rgba32f`)]));
}
if (!hardware.queryCounts?.shadows?.occluded) throw new Error('No hardware shadow occlusions were observed');
if (!hardware.queryCounts?.accepted || !hardware.hardwareRayTracingUsed) throw new Error('No hardware-selected hits were observed');
// These are fixture-specific same-adapter bounds, not cross-driver guarantees.
function assertParity(label, color, guides) {
  if (color.rgbMaxULP > 4 || color.rgbMaxAbs > 5e-7 || color.alphaMaxAbs !== 0
      || !Object.values(guides).every(result => result.bitIdentical)) {
    throw new Error(`${label}: HDR/AOV parity regression`);
  }
}
const validations = {};
for (const fixture of ['baseline', 'transforms']) {
  const directory = resolve(output, `validated-${fixture}`);
  run(`${fixture}-capture`, process.execPath, ['native/prepare-scene.mjs'], {
    MUTRACER_NATIVE_OUTPUT: directory, MUTRACER_NATIVE_FIXTURE: fixture, MUTRACER_NATIVE_VALIDATE_SHADOWS: '1'
  });
  const executable = resolve(target, 'release/mutracer-native-probe');
  run(`${fixture}-software`, executable, [resolve(directory, 'scene'), resolve(directory, 'software-image'), '256']);
  run(`${fixture}-hardware`, executable, [resolve(directory, 'scene'), resolve(directory, 'hardware-image'), '256', 'hwrt']);
  const result = JSON.parse(readFileSync(resolve(directory, 'hardware-image/result.json'), 'utf8'));
  composition[fixture] = verifyBvh(resolve(directory, 'scene'), resolve(directory, 'hardware-image'));
  const comparisons = {};
  for (const name of ['render', 'normal', 'albedo']) {
    comparisons[name] = JSON.parse(run(`${fixture}-${name}-comparison`, process.execPath, ['native/compare-hdr.mjs',
      resolve(directory, `software-image/${name}.rgba32f`), resolve(directory, `hardware-image/${name}.rgba32f`)]));
  }
  const shadows = result.queryCounts?.shadows;
  if (!shadows?.occluded || shadows.softwareComparisons !== shadows.queries || shadows.mismatches !== 0) {
    throw new Error(`${fixture}: hardware/software shadow decisions differ or were not all checked`);
  }
  validations[fixture] = { backend: result.intersectionBackend, queryCounts: result.queryCounts, comparisons };
}
// Prove rendering consumes raw geometry/AOT output, without the prebuilt BLAS buffer.
const rawOnly = resolve(output, 'raw-geometry-only');
rmSync(rawOnly, { recursive: true, force: true });
cpSync(resolve(output, 'scene'), resolve(rawOnly, 'scene'), { recursive: true });
const rawScene = JSON.parse(readFileSync(resolve(rawOnly, 'scene/scene.json'), 'utf8'));
const packedBvh = rawScene.buffers.find(buffer => buffer.id === rawScene.nativeBvh.buffer);
rmSync(resolve(rawOnly, 'scene', packedBvh.file));
run('raw-geometry-only-render', resolve(output, 'hwrt-host'), [resolve(rawOnly, 'scene'), resolve(rawOnly, 'image')]);
for (const name of ['render', 'normal', 'albedo', 'native-bvh']) {
  const file = name === 'native-bvh' ? `${name}.bin` : `${name}.rgba32f`;
  if (!readFileSync(resolve(rawOnly, 'image', file)).equals(readFileSync(resolve(output, 'hardware-image', file)))) {
    throw new Error(`Render without prebuilt BVH differs: ${name}`);
  }
}
composition.withoutPrebuiltBvh = true;
const summary = { inputs, rayQuery, composition, hybridRenderer: { queryCounts: hardware.queryCounts, comparison, aovs }, validations,
  acceptance: { sameAdapterColorMaxULP: 4, colorMaxAbs: 5e-7, guides: 'byte-identical', shadowDecisions: 'all compared; zero mismatches' } };
writeFileSync(resolve(output, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');
assertParity('C-driven baseline', comparison, aovs);
for (const [fixture, validation] of Object.entries(validations)) {
  const { render, ...guides } = validation.comparisons;
  assertParity(fixture, render, guides);
}
console.log(`Native input, ray-query, HDR/AOV and shadow checks passed: ${resolve(output, 'verification.json')}`);
