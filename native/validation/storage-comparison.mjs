// Windows CRT sin(PI / 4) and JavaScript Math.sin round to adjacent doubles.
// Only the final Float64 environment power may differ by one ULP; headers,
// byte/half atlas values and the Float32 CDF remain byte-exact.
export function compareStorageBytes(actual, expected, platform = process.platform) {
  actual = Buffer.from(actual); expected = Buffer.from(expected);
  const byteIdentical = actual.equals(expected);
  let powerUlps = 0;
  const result = matched => ({matched, byteIdentical, powerUlps});
  if (actual.length !== expected.length || expected.length < 24) return result(false);
  const powerOffset = 16 + expected.readUInt32LE(0) + expected.readUInt32LE(4);
  if (powerOffset + 8 !== expected.length) return result(false);
  const x = actual.readDoubleLE(powerOffset), y = expected.readDoubleLE(powerOffset);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return result(false);
  if (byteIdentical) return result(true);
  if (platform !== 'win32' || x <= 0 || y <= 0 ||
      !actual.subarray(0, powerOffset).equals(expected.subarray(0, powerOffset))) return result(false);
  const a = actual.readBigUInt64LE(powerOffset), b = expected.readBigUInt64LE(powerOffset);
  powerUlps = Number(a > b ? a - b : b - a);
  return result(powerUlps <= 1);
}
