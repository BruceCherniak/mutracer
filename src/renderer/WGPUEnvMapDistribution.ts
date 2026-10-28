const distributionWGSL = /* wgsl */ `
@group(0) @binding(0) var radiance: texture_2d<f32>;
// Per-texel inclusive row integral and unnormalized PDF, then per-row CDF/PDF.
@group(0) @binding(1) var<storage, read_write> pixels: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> rows: array<vec2f>;
@group(0) @binding(3) var output: texture_storage_2d<rg32float, write>;
var<workgroup> scan: array<f32, 256>;
var<workgroup> carry: f32;

fn inclusiveScan(lane: u32) {
  workgroupBarrier();
  for (var offset = 1u; offset < 256u; offset *= 2u) {
    var previous = 0.0;
    if (lane >= offset) { previous = scan[lane - offset]; }
    workgroupBarrier();
    scan[lane] += previous;
    workgroupBarrier();
  }
}

@compute @workgroup_size(256)
fn scanRows(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
  let size = textureDimensions(radiance);
  let y = group.x;
  if (lane == 0u) { carry = 0.0; }
  workgroupBarrier();
  for (var start = 0u; start < size.x; start += 256u) {
    let x = start + lane;
    var weight = 0.0;
    if (x < size.x) {
      // Match the CPU proposal's clamped 3×3 footprint around filtered HDR radiance.
      var maximum = 0.0;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          let p = clamp(vec2i(i32(x) + dx, i32(y) + dy), vec2i(0), vec2i(size) - 1);
          maximum = max(maximum, dot(textureLoad(radiance, p, 0).rgb, vec3f(0.2126, 0.7152, 0.0722)));
        }
      }
      weight = max(maximum, 1e-12) * sin(3.141592653589793 * (f32(y) + 0.5) / f32(size.y));
    }
    scan[lane] = weight / f32(size.x);
    inclusiveScan(lane);
    if (x < size.x) { pixels[y * size.x + x] = vec2f(carry + scan[lane], weight); }
    workgroupBarrier();
    if (lane == 0u) { carry += scan[255]; }
    workgroupBarrier();
  }
  if (lane == 0u) { rows[y] = vec2f(0.0, carry); }
}

@compute @workgroup_size(256)
fn scanMarginal(@builtin(local_invocation_index) lane: u32) {
  let height = textureDimensions(radiance).y;
  if (lane == 0u) { carry = 0.0; }
  workgroupBarrier();
  for (var start = 0u; start < height; start += 256u) {
    let y = start + lane;
    var integral = 0.0;
    if (y < height) { integral = rows[y].y; }
    scan[lane] = integral / f32(height);
    inclusiveScan(lane);
    if (y < height) { rows[y].x = carry + scan[lane]; }
    workgroupBarrier();
    if (lane == 0u) { carry += scan[255]; }
    workgroupBarrier();
  }
}

@compute @workgroup_size(16, 16)
fn normalize(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(radiance);
  let x = id.x;
  let y = id.y;
  if (x >= size.x + 2u || y >= size.y + 1u) { return; }
  var value = vec2f(0.0);
  if (x == 0u) {
    let total = rows[size.y - 1u].x;
    if (y > 0u) { value.x = rows[y - 1u].x / total; }
    if (y < size.y) { value.y = rows[y].y / total; }
  } else if (y < size.y) {
    let integral = rows[y].y;
    if (x > 1u) { value.x = pixels[y * size.x + x - 2u].x / integral; }
    if (x <= size.x) { value.y = pixels[y * size.x + x - 1u].y / integral; }
  }
  textureStore(output, vec2i(id.xy), vec4f(value, 0.0, 0.0));
}
`;

/** Builds the existing CDF/PDF texture layout without CPU readback or upload. */
export class WGPUEnvMapDistribution {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: GPUComputePipeline[];
  private pixels?: GPUBuffer;
  private rows?: GPUBuffer;

  static supported(device: GPUDevice, width: number, height: number) {
    // Large HDRIs can exceed a single storage binding; retain the CPU path there.
    return width * height * 8 <= Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize);
  }

  constructor(private readonly device: GPUDevice) {
    this.layout = device.createBindGroupLayout({
      label: 'Environment distribution',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rg32float' } }
      ]
    });
    const module = device.createShaderModule({ label: 'Environment distribution', code: distributionWGSL });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    this.pipelines = ['scanRows', 'scanMarginal', 'normalize'].map(entryPoint => device.createComputePipeline({
      label: `Environment distribution ${entryPoint}`, layout, compute: { module, entryPoint }
    }));
  }

  build(input: GPUTexture, output: GPUTexture) {
    const { width, height } = input;
    if (this.pixels?.size !== width * height * 8 || this.rows?.size !== height * 8) {
      this.dispose();
      this.pixels = this.device.createBuffer({ label: 'Environment row scans', size: width * height * 8, usage: GPUBufferUsage.STORAGE });
      this.rows = this.device.createBuffer({ label: 'Environment marginal scan', size: height * 8, usage: GPUBufferUsage.STORAGE });
    }
    const group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: input.createView() },
        { binding: 1, resource: { buffer: this.pixels! } },
        { binding: 2, resource: { buffer: this.rows! } },
        { binding: 3, resource: output.createView() }
      ]
    });
    const encoder = this.device.createCommandEncoder({ label: 'Environment distribution' });
    const workgroups = [[height, 1], [1, 1], [Math.ceil((width + 2) / 16), Math.ceil((height + 1) / 16)]];
    this.pipelines.forEach((pipeline, index) => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(...workgroups[index] as [number, number]);
      pass.end();
    });
    this.device.queue.submit([encoder.finish()]);
  }

  dispose() {
    this.pixels?.destroy();
    this.rows?.destroy();
    this.pixels = undefined;
    this.rows = undefined;
  }
}
