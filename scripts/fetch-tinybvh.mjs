import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const tinyBvhManifest = JSON.parse(await readFile(
  new URL('../src/tinybvh/upstream.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Shared by Web rebuilds and native build entry points, before invoking Cargo.
export async function prepareTinyBvh({
  cacheRoot = join(root, '.cache/tinybvh'),
  manifest = tinyBvhManifest,
  fetchImpl = globalThis.fetch
} = {}) {
  const includeDirectory = resolve(cacheRoot, manifest.revision);
  await mkdir(includeDirectory, {recursive: true});
  let staging;
  try {
    for (const {file, sha256: expected} of manifest.files) {
      const target = join(includeDirectory, file);
      try {
        if (sha256(await readFile(target)) === expected) continue;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const url = `https://raw.githubusercontent.com/jbikker/tinybvh/${manifest.revision}/${file}`;
      const response = await fetchImpl(url, {signal: AbortSignal.timeout(30_000)});
      if (!response.ok) throw new Error(`TinyBVH download failed: ${file} (HTTP ${response.status})`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== expected) throw new Error(`TinyBVH SHA-256 mismatch: ${file}`);
      // Publish only verified, complete files; interrupted or concurrent fetches
      // cannot expose a partially written header to a compiler.
      staging ??= await mkdtemp(join(includeDirectory, '.download-'));
      const temporary = join(staging, file);
      await writeFile(temporary, bytes);
      try {
        await rename(temporary, target);
      } catch (error) {
        // Windows can refuse replacement while a concurrent preparer reads
        // the published file. Accept its complete, checksum-verified winner;
        // keep reporting real permissions errors or corrupt cache contents.
        let published;
        if (['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) {
          try { published = await readFile(target); } catch {}
        }
        if (!published || sha256(published) !== expected) throw error;
      }
    }
  } finally {
    if (staging) await rm(staging, {recursive: true, force: true});
  }
  return includeDirectory;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    // stdout is consumed as the include directory by shell/PowerShell builders.
    console.log(await prepareTinyBvh());
  } catch (error) {
    console.error(`Unable to prepare TinyBVH: ${error.message}`);
    process.exitCode = 1;
  }
}
