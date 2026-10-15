export type AttributeData = Float32Array | Uint16Array | Uint32Array | Int32Array;

/** Explicit storage narrowing preserves every supported public attribute type. */
export function attributeValue(array: AttributeData, index: number): number {
  if (array instanceof Float32Array) return array[index];
  if (array instanceof Uint16Array) return array[index];
  if (array instanceof Uint32Array) return array[index];
  return array[index];
}

export function attributeLength(array: AttributeData): number {
  if (array instanceof Float32Array) return array.length;
  if (array instanceof Uint16Array) return array.length;
  if (array instanceof Uint32Array) return array.length;
  return array.length;
}
