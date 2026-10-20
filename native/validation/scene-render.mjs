import {prepareTinyBvh} from '../../scripts/fetch-tinybvh.mjs';
import {spawnCompiler} from '../scripts/compiler.mjs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeCoverage } from './diagnostics.mjs';
import { archiveName, cCompiler, cLinkFlags, executable, windows } from '../scripts/platform.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.env.MUTRACER_NATIVE_OUTPUT ?? resolve(root, '.native-build/scene-core'));
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(out, 'cargo-target'));
const compiler = process.env.MUTRACER_SCRIPTC ?? 'scriptc';
const samples = Number(process.env.MUTRACER_NATIVE_SAMPLES ?? '256');
if (!Number.isInteger(samples) || samples < 1 || samples > 4096)
    throw new Error('Samples must be 1..4096');
mkdirSync(out, { recursive: true });
const env = { ...process.env, MUTRACER_NATIVE_OUTPUT: out, CARGO_TARGET_DIR: target, MUTRACER_AOT_ARCHIVE: resolve(out, archiveName('render-core')) };
if(windows)env.PATH=resolve(target,'release')+delimiter+process.env.PATH;
const checks = [];
function run(name, command, args, check = true) {
    console.log(`${name}...`);
    const result = (command === compiler ? spawnCompiler : spawnSync)(command, args, { cwd: root, env, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(resolve(out, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    checks.push({ name, exitCode: result.status });
    writeFileSync(resolve(out, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
    if (result.error || check && result.status !== 0)
        throw new Error(`${name}: ${result.error?.message || result.stderr || result.stdout}`);
    return result;
}
if (run('compiler-version', compiler, ['--version']).stdout.trim() !== '0.3.2')
    throw new Error('Requires scriptc 0.3.2');
run('material-property-contract', process.execPath, ['native/scripts/generate-material-properties.mjs', '--check']);
const coverage = run('scene-coverage', compiler, ['coverage', 'native/src/scene-core.ts', '--print', 'diagnostics', '--fail-on', 'blockers'], false);
const diagnostics = JSON.parse(coverage.stdout);
writeFileSync(resolve(out, 'coverage.json'), JSON.stringify(diagnostics, null, 2));
const summary = summarizeCoverage(diagnostics, coverage.status);
writeFileSync(resolve(out, 'coverage-summary.json'), JSON.stringify(summary, null, 2));
if (!summary.passed)
    throw new Error('Composed scene graph has compiler diagnostics; inspect coverage.json');
const composed = run('render-core-coverage', compiler, ['coverage', 'native/src/render-core.ts', '--print', 'diagnostics', '--fail-on', 'blockers'], false);
const composedDiagnostics = JSON.parse(composed.stdout);
writeFileSync(resolve(out, 'render-core-coverage.json'), JSON.stringify(composedDiagnostics, null, 2));
if (!summarizeCoverage(composedDiagnostics, composed.status).passed)
    throw new Error('Full AOT entry graph has compiler diagnostics');
run('aot-build', compiler, ['build', '--lib', '--profile', 'native/src/render-core-profile.json', '-o', env.MUTRACER_AOT_ARCHIVE]);
await prepareTinyBvh();
run('native-build', 'cargo', ['build', '--release', '--locked', '--manifest-path', 'native/host/Cargo.toml']);
const sceneHost=resolve(out,executable('scene-host'));
run('scene-host-build', cCompiler, ['-Wall', '-Wextra', '-Werror', '-I', 'native/include', 'native/examples/scene-host.c',
    ...(windows?[resolve(target,'release/mutracer_native_probe.dll.lib')]:['-L',resolve(target,'release'),'-lmutracer_native_probe',`-Wl,-rpath,${resolve(target,'release')}`]),
    ...cLinkFlags,'-o',sceneHost]);
run('core-host-build', cCompiler, ['-Wall', '-Wextra', '-Werror', '-Dmt_module_init=mt_core_init', '-Dmt_module_reset=mt_core_reset', '-Dmt_module_collect=mt_core_collect', '-Dmt_module_sink=mt_core_sink', '-Dmt_module_run=mt_core_scene', 'native/tests/module-host.c', env.MUTRACER_AOT_ARCHIVE, ...cLinkFlags, '-o', resolve(out, executable('core-host'))]);
for (const variant of ['baseline', 'textures', 'transforms', 'orthographic', 'emissive', 'missing-normals', 'float-textures', 'sphere-light', 'directional-light', 'spot-light', 'alpha', 'v2-environment', 'v2-environment-only', 'v2-background', 'v2-hidden-background', 'v2-film', 'v2-medium', 'v2-alpha', 'v2-bevel', 'v2-vertices', 'v2-multimaterial', 'v2-instances', 'v2-empty-batch', 'v3-displacement-uv', 'v3-displacement-triplanar', 'v3-displacement-spherical', 'v3-displacement-cylindrical', 'v3-displacement-negative', 'v3-displacement-bytes', 'v3-displacement-zero', 'v3-ies', 'v3-ies-shared', 'v3-rect-texture'])
    run(`render-${variant}`, sceneHost, [resolve(out, variant === 'baseline' ? 'image' : variant), String(samples), variant, ...(variant === 'baseline' ? ['repeat'] : [])]);
run('verify-scenes', process.execPath, ['native/validation/scene-verify.mjs']);
// Both baseline renders execute in one C process with reset/collection between calls.
for (const name of ['render', 'normal', 'albedo'])
    if (!readFileSync(resolve(out, `image/${name}.rgba32f`)).equals(readFileSync(resolve(out, `image/repeat/${name}.rgba32f`))))
        throw new Error(`Repeated native ${name} differs`);
console.log(`Native scene image: ${resolve(out, 'image/render.png')}`);
