import {AovHistory, AOV_KINDS, AOV_LAYOUT, type AovKind, type AovFrameSnapshot} from './aov.js';
/** One target's optional AOV allocations and accepted frame history. */
export class WGPUAov {
  readonly history = new AovHistory();
  width = 0; height = 0; samples = 0; centerReady = false;
  accumulation?: GPUBuffer; center?: GPUBuffer; scene?: GPUBuffer;
  frame?: AovFrameSnapshot;
  constructor(readonly device: GPUDevice) {}
  reset() { this.samples = 0; this.centerReady = false; this.frame = undefined; }
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.dispose(); this.history.clear(); this.reset(); this.width = width; this.height = height;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.accumulation = this.device.createBuffer({label: 'AOV accumulation', size: width * height * AOV_LAYOUT.accumulatedBytes, usage});
    this.center = this.device.createBuffer({label: 'AOV center', size: width * height * AOV_LAYOUT.centerBytes, usage});
  }
  setScene(words: Uint32Array) {
    if (!this.scene || this.scene.size < words.byteLength) {
      this.scene?.destroy();
      this.scene = this.device.createBuffer({label: 'AOV identities/history', size: Math.max(16, words.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    }
    this.device.queue.writeBuffer(this.scene, 0, words);
  }
  get bytes() { return (this.accumulation?.size ?? 0) + (this.center?.size ?? 0) + (this.scene?.size ?? 0); }
  async read(kind: AovKind) {
    const center = kind === 'id' || kind === 'motion';
    const source = center ? this.center! : this.accumulation!;
    const staging = this.device.createBuffer({size: source.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    try {
      const encoder = this.device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, staging, 0, source.size);
      this.device.queue.submit([encoder.finish()]); await staging.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(staging.getMappedRange()), u = new Uint32Array(f.buffer);
      const data = kind === 'id' ? new Uint32Array(this.width*this.height*4) : new Float32Array(this.width*this.height*4);
      for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
        const target = (y * this.width + x) * 4;
        // Tracing uses OpenGL camera coordinates; API images are top row first.
        const pixel = ((this.height-1-y)*this.width+x), o = pixel * (center ? 8 : 16);
        if (kind === 'id') data.set(u.subarray(o, o+4), target);
        else if (kind === 'motion') data.set(f.subarray(o+4, o+8), target);
        else {
          const hits = f[o+7], coverage = hits / Math.max(1, this.samples), inv = hits > 0 ? 1 / hits : 0;
          if (kind === 'depth') data.set([f[o]*inv, 0, 0, coverage], target);
          else if (kind === 'position') data.set([f[o+4]*inv, f[o+5]*inv, f[o+6]*inv, coverage], target);
          else if (kind === 'roughness') data.set([f[o+1]*inv, f[o+2]*inv, f[o+3]*inv, coverage], target);
          else { const offset = kind === 'diffuseAlbedo' ? o+8 : o+12, valid = f[offset+3];
            const scale = valid > 0 ? 1/valid : 0;
            data.set([f[offset]*scale, f[offset+1]*scale, f[offset+2]*scale, valid / Math.max(1,this.samples)], target); }
        }
      }
      return {width: this.width, height: this.height, data};
    } finally { if (staging.mapState === 'mapped') staging.unmap(); staging.destroy(); }
  }
  dispose() { this.accumulation?.destroy(); this.center?.destroy(); this.scene?.destroy(); this.accumulation = this.center = this.scene = undefined; }
}
export const isAovKind = (kind: string): kind is AovKind => (AOV_KINDS as readonly string[]).includes(kind);
