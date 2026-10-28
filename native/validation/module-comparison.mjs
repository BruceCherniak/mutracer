// Packing stays exact. Only the sphere generator's near-zero trigonometric
// coordinates may differ between Windows CRT libm and JavaScript's libm.
export function compareModuleBytes(name, actual, expected, platform = process.platform) {
  actual = Buffer.from(actual); expected = Buffer.from(expected);
  const byteIdentical = actual.equals(expected);
  let nearZeroComponents = 0;
  if (byteIdentical) return {matched: true, byteIdentical, nearZeroComponents};
  if (platform !== 'win32' || name !== 'geometry' || actual.length !== expected.length ||
      expected.length < 64 || expected.length % 4 || expected.readUInt32LE(4) !== 0)
    return {matched: false, byteIdentical, nearZeroComponents};
  const end = 64 + (expected.readUInt32LE(16) + expected.readUInt32LE(20)) * 4;
  if (end > expected.length) return {matched: false, byteIdentical, nearZeroComponents};
  for (let offset = 0; offset < expected.length; offset += 4) {
    const a = actual.readUInt32LE(offset), b = expected.readUInt32LE(offset);
    if (a === b) continue;
    const x = actual.readFloatLE(offset), y = expected.readFloatLE(offset);
    if (offset < 64 || offset >= end || ((a ^ b) & 0x80000000) ||
        !Number.isFinite(x) || !Number.isFinite(y) ||
        Math.max(Math.abs(x), Math.abs(y)) > 1e-15 || Math.abs(x - y) > 1e-20)
      return {matched: false, byteIdentical, nearZeroComponents};
    nearZeroComponents++;
  }
  return {matched: true, byteIdentical, nearZeroComponents};
}
