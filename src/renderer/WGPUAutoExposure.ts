const HISTOGRAM_BIN_COUNT = 256;

export const autoExposureHistogramWGSL = /* wgsl */ `
struct AutoExposureParams {
  size: vec2u,
  minLuminance: f32,
  luminanceRange: f32,
  luminanceMapExponent: f32,
  adaptationRate: f32,
  deltaSeconds: f32,
  padding: f32,
}

@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>, 256>;
@group(0) @binding(2) var<uniform> params: AutoExposureParams;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.size.x || id.y >= params.size.y) { return; }
  let color = textureLoad(inputTexture, vec2i(id.xy), 0).rgb;
  let luminance = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  var bin = 0u;
  if (luminance > 1e-4) {
    var mapped = clamp(
      (luminance - params.minLuminance) / params.luminanceRange,
      0.0,
      1.0
    );
    mapped = pow(mapped, params.luminanceMapExponent);
    bin = u32(mapped * 254.0) + 1u;
  }
  atomicAdd(&histogram[bin], 1u);
}
`;

export const autoExposureWeightedAverageWGSL = /* wgsl */ `
struct AutoExposureParams {
  size: vec2u,
  minLuminance: f32,
  luminanceRange: f32,
  luminanceMapExponent: f32,
  adaptationRate: f32,
  deltaSeconds: f32,
  padding: f32,
}

@group(0) @binding(0) var<storage, read> histogram: array<u32, 256>;
@group(0) @binding(1) var<storage, read_write> exposureState: array<f32, 2>;
@group(0) @binding(2) var exposureTexture: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<uniform> params: AutoExposureParams;

var<workgroup> binContributions: array<f32, 256>;

fn computeAutoExposure(averageLuminance: f32) -> f32 {
  let sensorSensitivity = 100.0;
  let calibration = 12.5;
  let ev100 = log2((averageLuminance * sensorSensitivity) / calibration);
  let lensAttenuation = 0.65;
  let maximumLuminance = (78.0 / (lensAttenuation * sensorSensitivity))
    * exp2(ev100);
  return 1.0 / maximumLuminance;
}

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(local_invocation_index) index: u32) {
  let binSize = select(histogram[index], 0u, index == 0u);
  binContributions[index] = select(
    f32(binSize) * (f32(index) - 0.5) / 256.0,
    0.0,
    index == 0u
  );
  workgroupBarrier();

  var stride = 128u;
  loop {
    if (index < stride) {
      binContributions[index] += binContributions[index + stride];
    }
    workgroupBarrier();
    if (stride == 1u) { break; }
    stride >>= 1u;
  }

  if (index == 0u) {
    let validSamples = params.size.x * params.size.y - histogram[0];
    let mean = binContributions[0] / f32(max(validSamples, 1u));
    var averageLuminance = pow(mean, 1.0 / params.luminanceMapExponent);
    averageLuminance = averageLuminance * params.luminanceRange
      + params.minLuminance;

    let previous = exposureState[1];
    if (previous < 1e8) {
      let adaptation = 1.0 - exp(
        -params.deltaSeconds * 1000.0 * params.adaptationRate
      );
      averageLuminance = previous
        + (averageLuminance - previous) * adaptation;
    }
    let exposure = computeAutoExposure(max(averageLuminance, 1e-8));
    exposureState[0] = exposure;
    exposureState[1] = averageLuminance;
    textureStore(exposureTexture, vec2i(0), vec4f(exposure, 0.0, 0.0, 0.0));
  }
}
`;

/**
 * GPU histogram auto exposure, adapted from ZetaRay
 * (https://github.com/alipbcs/ZetaRay), Copyright (c) 2023-2024 Ali Behnoudfar,
 * MIT license.
 */
export class WGPUAutoExposure {
  private readonly histogram: GPUBuffer;
  private readonly exposureState: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly exposureTexture: GPUTexture;
  private readonly histogramPipeline: GPUComputePipeline;
  private readonly weightedAveragePipeline: GPUComputePipeline;
  private readonly weightedAverageBindGroup: GPUBindGroup;
  private width = 1;
  private height = 1;

  constructor(private readonly device: GPUDevice) {
    this.histogram = device.createBuffer({
      label: 'Auto exposure histogram',
      size: HISTOGRAM_BIN_COUNT * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.exposureState = device.createBuffer({
      label: 'Auto exposure state',
      size: 2 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    this.params = device.createBuffer({
      label: 'Auto exposure parameters',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.exposureTexture = device.createTexture({
      label: 'Auto exposure',
      size: [1, 1],
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.histogramPipeline = device.createComputePipeline({
      label: 'Auto exposure histogram',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          label: 'Auto exposure histogram',
          code: autoExposureHistogramWGSL
        }),
        entryPoint: 'main'
      }
    });
    this.weightedAveragePipeline = device.createComputePipeline({
      label: 'Auto exposure weighted average',
      layout: 'auto',
      compute: {
        module: device.createShaderModule({
          label: 'Auto exposure weighted average',
          code: autoExposureWeightedAverageWGSL
        }),
        entryPoint: 'main'
      }
    });
    this.weightedAverageBindGroup = device.createBindGroup({
      label: 'Auto exposure weighted average',
      layout: this.weightedAveragePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.histogram } },
        { binding: 1, resource: { buffer: this.exposureState } },
        { binding: 2, resource: this.exposureTexture.createView() },
        { binding: 3, resource: { buffer: this.params } }
      ]
    });
  }

  setSize(width: number, height: number) {
    this.width = Math.max(1, Math.ceil(width));
    this.height = Math.max(1, Math.ceil(height));
  }

  createPass(
    encoder: GPUCommandEncoder,
    inputTexture: GPUTexture,
    deltaSeconds: number
  ) {
    const raw = new ArrayBuffer(32);
    const view = new DataView(raw);
    view.setUint32(0, this.width, true);
    view.setUint32(4, this.height, true);
    view.setFloat32(8, 5e-3, true);
    view.setFloat32(12, 4.0 - 5e-3, true);
    view.setFloat32(16, 0.5, true);
    view.setFloat32(20, 1.0, true);
    view.setFloat32(24, Math.max(deltaSeconds, 1e-6), true);
    this.device.queue.writeBuffer(this.params, 0, raw);
    encoder.clearBuffer(this.histogram);

    const histogramBindGroup = this.device.createBindGroup({
      label: 'Auto exposure histogram',
      layout: this.histogramPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: inputTexture.createView() },
        { binding: 1, resource: { buffer: this.histogram } },
        { binding: 2, resource: { buffer: this.params } }
      ]
    });
    const histogramPass = encoder.beginComputePass({
      label: 'Auto exposure histogram'
    });
    histogramPass.setPipeline(this.histogramPipeline);
    histogramPass.setBindGroup(0, histogramBindGroup);
    histogramPass.dispatchWorkgroups(
      Math.ceil(this.width / 16),
      Math.ceil(this.height / 16)
    );
    histogramPass.end();

    const averagePass = encoder.beginComputePass({
      label: 'Auto exposure weighted average'
    });
    averagePass.setPipeline(this.weightedAveragePipeline);
    averagePass.setBindGroup(0, this.weightedAverageBindGroup);
    averagePass.dispatchWorkgroups(1);
    averagePass.end();
  }

  getOutput() {
    return this.exposureTexture;
  }

  dispose() {
    this.histogram.destroy();
    this.exposureState.destroy();
    this.params.destroy();
    this.exposureTexture.destroy();
  }
}

export default WGPUAutoExposure;
