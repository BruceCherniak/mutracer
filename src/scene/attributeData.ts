export type AttributeData = Float32Array | Uint16Array | Uint32Array | Int32Array;

export function attributeValue(array: AttributeData, index: number): number {
  return array[index];
}
export function attributeLength(array: AttributeData): number {
  return array.length;
}
