export function prepareHardwareCapture(pass: {
  _hasDisplacement: boolean;
  _constants: { HAS_ALPHA?: boolean };
  _rtUniform: { views: { bevel: Int32Array; blasOffset: Int32Array } };
  _instancesBuffer: { data: Uint8Array };
  _bvhBuffer: { data: Uint8Array };
  _attributeData: Float32Array;
  _attributeStride: number;
  _attributeOffsets: number[];
}, save: (name: string, data: Uint8Array | string) => string, source: string): {
  eligible: boolean; hardwareClosest?: boolean; validateShadows?: boolean; reason?: string; shader?: string; triangleMap?: string;
  geometries?: { positions: string; vertexCount: number; mapBase: number }[];
  instances?: { geometry: number; customIndex: number; transform: number[] }[];
};
