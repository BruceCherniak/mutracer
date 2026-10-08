const peakMeterWGSL = /* wgsl */ `
@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> peakBits: atomic<u32>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(inputTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let color = max(textureLoad(inputTexture, vec2i(id.xy), 0).rgb, vec3f(0.0));
  let peak = max(color.r, max(color.g, color.b));
  if (peak < 65504.0) {
    atomicMax(&peakBits, bitcast<u32>(peak));
  }
}
`;

/** Periodically measures the largest encoded value sent to an HDR canvas. */
export class WGPUHDRPeakMeter {
  private readonly peakBuffer: GPUBuffer;
  private readonly readbackBuffer: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private pending = false;
  private disposed = false;
  private lastSubmissionTime = -Infinity;
  private peakDisplayValue = 0;

  constructor(private readonly device: GPUDevice) {
    this.peakBuffer = device.createBuffer({
      label: 'HDR display peak',
      size: Uint32Array.BYTES_PER_ELEMENT,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST
    });
    this.readbackBuffer = device.createBuffer({
      label: 'HDR display peak readback',
      size: Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    this.pipeline = device.createComputePipeline({
      label: 'HDR display peak',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          label: 'HDR display peak',
          code: peakMeterWGSL
        }),
        entryPoint: 'main'
      }
    });
  }

  encode(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    width: number,
    height: number,
    now = performance.now()
  ) {
    if (this.pending || now - this.lastSubmissionTime < 500) return false;
    this.pending = true;
    this.lastSubmissionTime = now;
    encoder.clearBuffer(this.peakBuffer);
    const bindGroup = this.device.createBindGroup({
      label: 'HDR display peak',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputTexture.createView() },
        { binding: 1, resource: { buffer: this.peakBuffer } }
      ]
    });
    const pass = encoder.beginComputePass({ label: 'HDR display peak' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
    pass.end();
    encoder.copyBufferToBuffer(
      this.peakBuffer,
      0,
      this.readbackBuffer,
      0,
      Uint32Array.BYTES_PER_ELEMENT
    );
    return true;
  }

  async resolve() {
    if (!this.pending || this.disposed) return;
    try {
      await this.readbackBuffer.mapAsync(GPUMapMode.READ);
      const mapped = this.readbackBuffer.getMappedRange();
      const bits = new Uint32Array(mapped)[0];
      const raw = new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT);
      new Uint32Array(raw)[0] = bits;
      this.peakDisplayValue = new Float32Array(raw)[0];
      this.readbackBuffer.unmap();
    } catch {
      if (this.readbackBuffer.mapState === 'mapped') {
        this.readbackBuffer.unmap();
      }
    } finally {
      this.pending = false;
    }
  }

  getPeakDisplayValue() {
    return this.peakDisplayValue;
  }

  reset() {
    this.peakDisplayValue = 0;
    this.lastSubmissionTime = -Infinity;
  }

  dispose() {
    this.disposed = true;
    void this.device.queue.onSubmittedWorkDone().catch(() => undefined).then(() => {
      this.peakBuffer.destroy();
      this.readbackBuffer.destroy();
    });
  }
}

export default WGPUHDRPeakMeter;
