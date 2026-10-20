export function compareModuleBytes(
  name: string,
  actual: Uint8Array,
  expected: Uint8Array,
  platform?: string
): {matched: boolean; byteIdentical: boolean; nearZeroComponents: number};
