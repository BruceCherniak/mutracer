/** Engine-owned flat RGBA input snapshot, leased until the current inference finishes. */
export class WGPUScratchBuffer {
  private buffer?: GPUBuffer;
  constructor(private readonly device: GPUDevice) {}
  get(bytes: number, exact = false) {
    if (!this.buffer || (exact ? this.buffer.size !== bytes : this.buffer.size < bytes)) {
      const previous = this.buffer;
      this.buffer = this.device.createBuffer({label: 'Shared inference input', size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
      if (previous) void this.device.queue.onSubmittedWorkDone().catch(() => {}).then(() => previous.destroy());
    }
    return this.buffer;
  }
  getMemoryBytes() {return this.buffer?.size ?? 0;}
  dispose() {this.buffer?.destroy();}
}
