import { readFileSync, writeFileSync } from 'node:fs';

const [referenceFile, candidateFile, outputFile] = process.argv.slice(2);
if (!referenceFile || !candidateFile) throw new Error('Usage: compare-hdr.mjs REFERENCE CANDIDATE [REPORT.json]');
const reference = readFileSync(referenceFile), candidate = readFileSync(candidateFile);
if (reference.length !== candidate.length || reference.length % 16 !== 0) throw new Error('HDR buffer sizes differ or are invalid');
let sum = 0, squared = 0, maxAbs = 0, maxAt = 0, referenceSquared = 0, alphaMax = 0, rgbDifferent = 0, maxULP = 0;
const ordered = bits => bits & 0x80000000 ? 0x80000000 - (bits & 0x7fffffff) : 0x80000000 + bits;
for (let i = 0; i < reference.length / 4; i++) {
  const a = reference.readFloatLE(i * 4), b = candidate.readFloatLE(i * 4);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Non-finite input at component ${i}`);
  const d = Math.abs(a - b);
  if (i % 4 === 3) { alphaMax = Math.max(alphaMax, d); continue; }
  maxULP = Math.max(maxULP, Math.abs(ordered(reference.readUInt32LE(i * 4)) - ordered(candidate.readUInt32LE(i * 4))));
  sum += d; squared += d * d; referenceSquared += a * a;
  if (d > maxAbs) { maxAbs = d; maxAt = i; }
  if (a !== b) rgbDifferent++;
}
const count = reference.length / 16 * 3;
const report = { reference: referenceFile, candidate: candidateFile, pixels: reference.length / 16,
  bitIdentical: reference.equals(candidate), rgbMAE: sum / count, rgbRMSE: Math.sqrt(squared / count),
  relativeL2: Math.sqrt(squared / Math.max(referenceSquared, 1e-30)), rgbMaxAbs: maxAbs,
  rgbMaxAtComponent: maxAt, rgbMaxULP: maxULP, rgbDifferentComponents: rgbDifferent, alphaMaxAbs: alphaMax,
  note: 'Metrics only; tolerance and rendering contract must be assessed separately.' };
if (outputFile) writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
