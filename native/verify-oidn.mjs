import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, process.env.MUTRACER_NATIVE_OUTPUT ?? '.native-build');
// Compare actual JavaScript distribution against C-hosted machine code.
// Run build:lib and native:check first; the latter is expected to exit 1.
const js = await import(pathToFileURL(resolve(root, 'lib/oidn.js')).href);
const executable = resolve(output, 'oidn-host');
const linked = spawnSync(process.env.CC ?? 'cc', [
  '-Wall', '-Wextra', '-Werror', 'native/oidn-host.c', resolve(output, 'oidn.lib.a'),
  '-o', executable, '-lm', '-lpthread'
], { cwd: root, encoding: 'utf8' });
if (linked.error) throw linked.error;
assert.equal(linked.status, 0, linked.stderr);

let cases = 0;
function native(args) {
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  cases++;
  return result.stdout;
}
assert.deepEqual(JSON.parse(native(['defaults'])), {
  package: js.OIDN_WEIGHTS_PACKAGE,
  version: js.OIDN_WEIGHTS_PACKAGE_VERSION,
  base: js.DEFAULT_OIDN_WEIGHTS_PACKAGE_BASE_URL,
  fallbackBase: js.DEFAULT_OIDN_WEIGHTS_BASE_URL,
  models: js.OIDN_MODEL_FILENAMES,
  auxiliaryModels: js.OIDN_AUXILIARY_MODEL_FILENAMES,
  standard: js.resolveOIDNModelUrl('standard'),
  small: js.resolveOIDNModelUrl('small'),
  cleanAuxLarge: js.resolveOIDNModelUrl('cleanAuxLarge'),
  auxiliary: js.resolveOIDNAuxiliaryModelUrls()
});
for (const base of ['', './weights', '/tmp/weights/', 'https://example.test/weights',
  'https://example.test/模型/', 'https://example.test/a/../b/?v=1#x']) {
  for (const asUrl of [false, true]) {
    if (asUrl && !URL.canParse(base)) continue;
    const input = asUrl ? new URL(base) : base;
    for (const model of ['standard', 'small', 'cleanAuxLarge']) {
      assert.equal(native(['model', model, base, String(Number(asUrl))]), js.resolveOIDNModelUrl(model, input));
    }
    assert.deepEqual(JSON.parse(native(['auxiliary', '', base, String(Number(asUrl))])),
      js.resolveOIDNAuxiliaryModelUrls(input));
  }
}
const invalid = spawnSync(executable, ['model', 'invalid', '', '0'], { encoding: 'utf8' });
if (invalid.error) throw invalid.error;
assert.equal(invalid.status, 70);
assert.match(invalid.stderr, /Unknown OIDN model/);
const summary = { cases, repeatedCalls: cases * 100, invalidInputPanics: 1,
  scope: 'OIDN URL helpers only; no denoising, GPU or full renderer validation' };
writeFileSync(resolve(output, 'oidn-verification.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
