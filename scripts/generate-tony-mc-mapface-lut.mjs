import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Source: tony_mc_mapface.dds from https://github.com/h3r2tic/tony-mc-mapface (MIT)
const input = process.argv[2];
if (!input) {
  throw new Error('Usage: node scripts/generate-tony-mc-mapface-lut.mjs <tony_mc_mapface.dds>');
}
const output = path.resolve(root, 'src/renderer/tonyMcMapfaceLutData.ts');
const dds = await readFile(input);
const headerBytes = 148;
const lutSize = 48;
const expectedPayloadBytes = lutSize ** 3 * 4;
if (dds.toString('ascii', 0, 4) !== 'DDS ' || dds.length !== headerBytes + expectedPayloadBytes) {
  throw new Error(`Unexpected Tony McMapface DDS layout: ${input}`);
}
if (dds.readUInt32LE(128) !== 67) {
  throw new Error('Tony McMapface DDS must use DXGI_FORMAT_R9G9B9E5_SHAREDEXP');
}
const payload = dds.subarray(headerBytes).toString('base64');
const lines = payload.match(/.{1,100}/g) || [];
const source = `// Generated from the Tony McMapface 48^3 R9G9B9E5 LUT.\n` +
  `// Copyright (c) 2023 Tomasz Stachowiak; MIT license.\n` +
  `// See LICENSES/TonyMcMapface-MIT.txt. Do not edit by hand.\n` +
  `export const TONY_MC_MAPFACE_RGB9E5_BASE64 =\n` +
  lines.map((line) => `  '${line}'`).join(' +\n') + `;\n`;
await writeFile(output, source);
