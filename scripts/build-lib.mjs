import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, 'lib');

rmSync(outputRoot, { recursive: true, force: true });

const tscPath = path.join(
  projectRoot,
  'node_modules',
  'typescript',
  'bin',
  'tsc'
);
const result = spawnSync(process.execPath, [tscPath], {
  cwd: projectRoot,
  stdio: 'inherit'
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const tinyBvhOutput = path.join(outputRoot, 'tinybvh');
mkdirSync(tinyBvhOutput, { recursive: true });
copyFileSync(
  path.join(projectRoot, 'src', 'tinybvh', 'tinybvh.wasm'),
  path.join(tinyBvhOutput, 'tinybvh.wasm')
);
copyFileSync(
  path.join(projectRoot, 'src', 'tinybvh', 'LICENSE'),
  path.join(tinyBvhOutput, 'LICENSE')
);

// Source builds let Vite discover the TypeScript worker; published ESM uses
// the adjacent compiled JavaScript entry so consumers need no TS loader.
const workerClientPath = path.join(outputRoot, 'renderer', 'bvhWorkerClient.js');
writeFileSync(workerClientPath,
  readFileSync(workerClientPath, 'utf8').replace('./bvh.worker.ts', './bvh.worker.js'));
