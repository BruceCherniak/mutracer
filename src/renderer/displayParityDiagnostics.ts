// Internal fixture input: additive accumulation in bottom-row-first order.
// Not part of src/main.ts or the supported rendering diagnostics contract.
export interface DisplayParityAccumulation {
  width: number; height: number; samples: number; catcher: boolean;
  color: Float32Array; albedo: Float32Array; normal: Float32Array;
  shadow: Float32Array; moments: Float32Array;
}
