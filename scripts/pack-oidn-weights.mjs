import { rm, mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const output = new URL('dist-oidn-weights/', root);
const hashes = {
  "rt_hdr_alb_nrm.tza": "e586ef2ff48d7fbb7611986405220ed8fc5c13ca79bfc40be4dc742fbf959e1a",
  "rt_hdr_alb_nrm_small.tza": "980ea307e7825cae23ed8b1addf8de62ece84b61094795a5631ebf1c91b2e1a7",
  "rt_hdr_calb_cnrm_large.tza": "08130cdc4f33b7a513d0073757f089ac830f900613bb5bad72ca42c52b934465",
  "rt_alb_large.tza": "a8efbe6eed511f41c8f5ff9145923214cefb0703cf91a3b00a1dc131ade1600a",
  "rt_nrm_large.tza": "8ac7705ec5ac303116b40ad2f0880cd741ed1f4280828bf2f18f7635c3377257"
};
await rm(output, { recursive: true, force: true });
await mkdir(output);
for (const name of ['package.json', 'README.md']) {
  await copyFile(new URL(`oidn/package/${name}`, root), new URL(name, output));
}
await copyFile(new URL('oidn/weights/LICENSE.txt', root), new URL('LICENSE.txt', output));
for (const [name, expected] of Object.entries(hashes)) {
  const source = new URL(`oidn/weights/${name}`, root);
  const actual = createHash('sha256').update(await readFile(source)).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}: ${actual}`);
  await copyFile(source, new URL(name, output));
}
console.log('Prepared oidn-weights@2.3.0-1 with five verified networks.');
