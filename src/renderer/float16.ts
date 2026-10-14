// Round to nearest, ties to even, matching RGBA16F storage on both backends.
function roundEven(value: number) {
  const integer = Math.floor(value);
  const fraction = value - integer;
  return integer + Number(fraction > 0.5 || fraction === 0.5 && integer % 2 === 1);
}

export function float16Bits(value: number): number {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const absolute = Math.abs(value);
  if (Number.isNaN(absolute)) return 0x7e00;
  if (absolute >= 65520) return sign | 0x7c00;
  if (absolute < 2 ** -14) return sign | roundEven(absolute * 2 ** 24);
  const exponent = Math.floor(Math.log2(absolute));
  return sign | ((exponent + 14) * 1024 + roundEven(absolute / 2 ** (exponent - 10)));
}
