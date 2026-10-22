export function compareStorageBytes(actual: Uint8Array, expected: Uint8Array, platform?: string): {
  matched: boolean;
  byteIdentical: boolean;
  powerUlps: number;
};
