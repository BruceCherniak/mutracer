interface CaptureBuffer { data: Uint8Array; size: number }
export class CaptureDevice {
  createBuffer(descriptor: { size: number }): CaptureBuffer;
  queue: {
    writeBuffer(buffer: CaptureBuffer, offset: number, data: ArrayBuffer | ArrayBufferView,
      dataOffset?: number, size?: number): void;
  };
}
export function installWebGPUConstants(): void;
