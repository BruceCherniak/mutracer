import {getTargetShaderCache} from './WGPUShaderCache.js';
import {JNLM_MAX_ITERATIONS, type JNLMFilterShape} from './jnlm.js';
import {
  JNLM_WORKGROUP_SIZE, jnlmGuideWGSL, jnlmVarianceWGSL, jnlmLoadColorWGSL,
  createJNLMFilterWGSL, packJNLMParameters
} from './wgsl/jnlm.compute.js';
export {createJNLMFilterWGSL, jnlmGuideWGSL, jnlmVarianceWGSL, jnlmLoadColorWGSL, JNLM_WORKGROUP_SIZE} from './wgsl/jnlm.compute.js';

/** WebGPU passes of the JNLM denoiser described in `jnlm.ts`. */

export interface JNLMInputs {
  width: number;
  height: number;
  /** Normalized shadow-catcher mask; red is the catcher coverage. */
  shadowCatcher: GPUTexture;
  /** Ray-trace auxiliary accumulation holding the guide moments. */
  accumulation: GPUBuffer;
  /** Ray-trace normal accumulation; its alpha is the per-pixel sample count. */
  normalAccumulation: GPUBuffer;
  /** Composed linear image to filter. */
  color: GPUTexture;
  albedo: GPUTexture;
  normal: GPUTexture;
  strength: number;
  shape: JNLMFilterShape;
}

const MAX_ITERATIONS = JNLM_MAX_ITERATIONS;

export class WGPUJNLMDenoisePass {
  private _device: GPUDevice;
  private _paramsBuffers: GPUBuffer[] = [];
  private _guidePipeline: GPUComputePipeline;
  private _variancePipeline: GPUComputePipeline;
  private _loadColorPipeline: GPUComputePipeline;
  private _filterPipeline?: GPUComputePipeline;
  private _filterShapeKey = '';
  private _guides: GPUBuffer[] = [];
  private _colors: GPUBuffer[] = [];
  private _width = 0;
  private _height = 0;

  constructor(device: GPUDevice) {
    this._device = device;
    // One uniform buffer per pass: every pass of an encoder sees the last
    // writeBuffer() of a shared one.
    for (let i = 0; i <= MAX_ITERATIONS; i++) {
      this._paramsBuffers.push(device.createBuffer({
        label: 'JNLM params',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
    }
    this._guidePipeline = this._createPipeline('JNLM guide', jnlmGuideWGSL);
    this._variancePipeline = this._createPipeline('JNLM variance', jnlmVarianceWGSL);
    this._loadColorPipeline = this._createPipeline('JNLM load color', jnlmLoadColorWGSL);
  }

  private _createPipeline(label: string, code: string) {
    return getTargetShaderCache(this._device).createComputePipeline({
      label,
      layout: 'auto',
      compute: {
        module: getTargetShaderCache(this._device).createShaderModule({ label, code }),
        entryPoint: 'main'
      }
    });
  }

  private _getFilterPipeline(shape: JNLMFilterShape) {
    const key = JSON.stringify(shape);
    if (!this._filterPipeline || key !== this._filterShapeKey) {
      this._filterPipeline = this._createPipeline('JNLM filter', createJNLMFilterWGSL(shape));
      this._filterShapeKey = key;
    }
    return this._filterPipeline;
  }

  reserveCapacity() {}
  private _ensureBuffers(width: number, height: number) {
    if (width <= this._width && height <= this._height && this._colors.length) return;
    width = Math.max(width, this._width); height = Math.max(height, this._height);
    this._destroyBuffers();
    const pixels = width * height;
    const createBuffer = (label: string, bytes: number) =>
      this._device.createBuffer({
        label,
        size: pixels * bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
    this._guides = [createBuffer('JNLM guide A', 8), createBuffer('JNLM guide B', 8)];
    this._colors = [createBuffer('JNLM color A', 16), createBuffer('JNLM color B', 16)];
    this._width = width;
    this._height = height;
  }

  private _destroyBuffers() {
    for (const buffer of [...this._guides, ...this._colors]) buffer.destroy();
    this._guides = [];
    this._colors = [];
  }

  /** Encodes the denoiser and returns the RGBA32F output in texture rows. */
  encode(encoder: GPUCommandEncoder, inputs: JNLMInputs): GPUBuffer {
    const { width, height, shape } = inputs;
    this._ensureBuffers(width, height);
    const iterations = Math.min(Math.max(Math.round(shape.iterations), 1), MAX_ITERATIONS);
    this._paramsBuffers.forEach((buffer, i) => {
      // Buffer i (from 1) is filter pass i - 1; index 0 is the prepasses.
      const params = packJNLMParameters(width, height, inputs.strength, Math.max(i - 1, 0));
      this._device.queue.writeBuffer(buffer, 0, params);
    });

    const device = this._device;
    const filterPipeline = this._getFilterPipeline(shape);
    const bind = (
      pipeline: GPUComputePipeline,
      paramsBuffer: GPUBuffer,
      resources: GPUBindingResource[]
    ) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          ...resources.map((resource, i) => ({ binding: i + 1, resource }))
        ]
      });
    const [guideA, guideB] = this._guides;
    const [colorA, colorB] = this._colors;
    const prepass = this._paramsBuffers[0];
    const passes: [GPUComputePipeline, GPUBindGroup][] = [
      [this._guidePipeline, bind(this._guidePipeline, prepass, [
        { buffer: inputs.accumulation },
        { buffer: inputs.normalAccumulation },
        { buffer: guideB }
      ])],
      [this._variancePipeline, bind(this._variancePipeline, prepass, [
        { buffer: guideB },
        { buffer: guideA }
      ])],
      [this._loadColorPipeline, bind(this._loadColorPipeline, prepass, [
        inputs.color.createView(),
        { buffer: colorA }
      ])]
    ];
    const albedoView = inputs.albedo.createView();
    const normalView = inputs.normal.createView();
    const shadowCatcherView = inputs.shadowCatcher.createView();
    let guides = [guideA, guideB];
    let colors = [colorA, colorB];
    for (let i = 1; i <= iterations; i++) {
      passes.push([filterPipeline, bind(filterPipeline, this._paramsBuffers[i], [
        { buffer: guides[0] },
        { buffer: colors[0] },
        albedoView,
        normalView,
        { buffer: colors[1] },
        { buffer: guides[1] },
        shadowCatcherView
      ])]);
      guides = [guides[1], guides[0]];
      colors = [colors[1], colors[0]];
    }
    const pass = encoder.beginComputePass({ label: 'JNLM denoise' });
    for (const [pipeline, bindGroup] of passes) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(width / JNLM_WORKGROUP_SIZE),
        Math.ceil(height / JNLM_WORKGROUP_SIZE)
      );
    }
    pass.end();
    return colors[0];
  }

  getMemoryBytes() {
    return [...this._paramsBuffers, ...this._guides, ...this._colors]
      .reduce((sum, buffer) => sum + buffer.size, 0);
  }

  dispose() {
    for (const buffer of this._paramsBuffers) buffer.destroy();
    this._destroyBuffers();
  }
}
