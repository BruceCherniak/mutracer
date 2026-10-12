import { getTargetShaderCache } from './WGPUShaderCache.js';
// TODO output read write buffer
import { getUniformBuffer, Uniform } from './WGPUFullQuadPass.js';

export type { Uniform };

function isStorageParamsEqual(
  params: WGPUComputePassOutput,
  other: WGPUComputePassOutput
) {
  return (
    params.channels === other.channels &&
    params.type === other.type &&
    params.count === other.count &&
    params.atomic === other.atomic
  );
}

export const WORKGROUP_SIZE = 8;

export interface WGPUComputePassInput {
  buffer?: GPUBuffer;
  texture?: GPUTexture;
  channels: number;
  type?: 'u32' | 'i32' | 'f32';
}

export interface WGPUComputePassOutput {
  channels?: number;
  // Default: 1. Count per element.
  count?: number;
  atomic?: boolean;
  type?: 'u32' | 'i32' | 'f32';
}

export class WGPUComputePass<I extends string, O extends string> {
  private _label;

  private _device;
  private _outputBuffers: Record<string, GPUBuffer> = {};
  private _outputParams: Record<string, WGPUComputePassOutput> = {};

  private _pipeline!: GPUComputePipeline;
  private _bindGroups: GPUBindGroup[] = [];
  private _needsUpdatePipeline = true;

  private _inputs: string[] = [];
  private _outputs: string[] = [];
  private _uniforms: Uniform[] = [];
  private _uniformsMap: Record<string, Uniform> = {};
  private _uniformBuffers: Record<string, GPUBuffer> = {};

  private _width = 10;
  private _height = 10;

  private _execWidth?: number;
  private _execHeight?: number;

  private _workGroupSize = [WORKGROUP_SIZE, WORKGROUP_SIZE];

  private _csCode = '';
  private _csMain;
  private _csDefine;

  private _groupOffsets = {
    inputs: 0,
    uniforms: 1,
    outputs: 2
  };

  constructor(
    label: string,
    device: GPUDevice,
    opts: {
      inputs: I[];
      outputs: O[];
      csMain: string;
      csDefine?: string;
      uniforms?: Uniform[];
    }
  ) {
    this._label = label;
    this._device = device;
    this._csMain = opts.csMain;
    this._csDefine = opts.csDefine;
    this._inputs = opts.inputs;
    this._outputs = opts.outputs;
    const uniforms = opts.uniforms || [];
    this._uniforms = uniforms;

    this._uniformsMap = this._uniforms.reduce((map, uniform) => {
      map[uniform.label] = uniform;
      return map;
    }, {} as Record<string, Uniform>);
    uniforms.forEach((uniform) => {
      const data = getUniformBuffer(uniform.data, uniform.type);
      this._uniformBuffers[uniform.label] = device.createBuffer({
        label: this._label + '.' + uniform.label,
        size: data.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      this._device.queue.writeBuffer(
        this._uniformBuffers[uniform.label],
        0,
        data
      );
    });
  }

  setCSCode({ csDefine, csMain }: { csDefine: string; csMain: string }) {
    this._csDefine = csDefine;
    this._csMain = csMain;
    this._needsUpdatePipeline = true;
  }

  setSize(width: number, height: number) {
    width = Math.ceil(width);
    height = Math.ceil(height);
    const sizeChanged = width !== this._width || height !== this._height;
    this._width = width;
    this._height = height;
    if (sizeChanged) {
      this._needsUpdatePipeline = true;
      // Invalidate all buffers
      for (const key in this._outputBuffers) {
        this._outputBuffers[key].destroy();
      }
      this._outputBuffers = {};
    }
  }

  setExecuteSize(width: number, height: number) {
    width = Math.ceil(width);
    height = Math.ceil(height);
    this._execWidth = width;
    this._execHeight = height;
  }

  setOutputParams(outputParams: Record<O, WGPUComputePassOutput>) {
    // TODO lazy update buffers
    this._invalidateChangedOutputBuffers(outputParams);
    this._outputParams = outputParams;
    this._needsUpdatePipeline = true;
  }

  setUniform(label: string, data: Uniform['data']) {
    const buffer = this._uniformBuffers[label];
    this._device.queue.writeBuffer(
      buffer,
      0,
      getUniformBuffer(data, this._uniformsMap[label].type)
    );
  }

  getOutput(name: O) {
    const outputBuffers = this._outputBuffers;
    if (!outputBuffers[name]) {
      outputBuffers[name] = this._createBuffer(
        name,
        this._outputParams[name] || {}
      );
    }
    return outputBuffers[name];
  }

  getMemoryBytes() {
    return [...Object.values(this._uniformBuffers), ...Object.values(this._outputBuffers)]
      .reduce((sum, buffer) => sum + buffer.size, 0);
  }

  dispose() {
    Object.keys(this._uniformBuffers).forEach((key) => {
      (this._uniformBuffers as any)[key].destroy();
    });
    Object.keys(this._outputBuffers).forEach((key) => {
      (this._outputBuffers as any)[key].destroy();
    });
  }

  setWorkGroupSize(width: number, height: number) {
    this._needsUpdatePipeline =
      width !== this._workGroupSize[0] || height !== this._workGroupSize[1];
    this._workGroupSize = [width, height];
  }

  private _getActualWorkgroupSize() {
    return [
      Math.min(this._workGroupSize[0], this._execWidth ?? this._width),
      Math.min(this._workGroupSize[1], this._execHeight ?? this._height)
    ];
  }

  private _createBuffer(label: string, params: WGPUComputePassOutput) {
    const channels = params.channels ?? 4;
    const byteLength =
      this._width * this._height * channels * (params.count ?? 1) * 4;
    return this._device.createBuffer({
      label: this._label + '.' + label,
      // webgpu needs buffer at least 80 bytes.
      size: Math.max(byteLength, 80),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
  }

  private _invalidateChangedOutputBuffers(newParams: Record<string, any>) {
    const outputBuffers = this._outputBuffers;
    const oldParams = this._outputParams;
    for (const key in outputBuffers) {
      if (!isStorageParamsEqual(newParams[key] || {}, oldParams[key] || {})) {
        outputBuffers[key].destroy();
        delete outputBuffers[key];
      }
    }
  }

  private _updateOutputBuffers(excludes?: string[]) {
    const outputBuffers = this._outputBuffers;
    const params = this._outputParams;
    for (const key in params) {
      if (!outputBuffers[key] && !excludes?.includes(key)) {
        outputBuffers[key] = this._createBuffer(key, params[key]);
      }
    }
  }

  private _updatePipeline(
    inputParams: Record<string, WGPUComputePassInput>,
    inputTypes: Record<string, 'texture' | 'buffer'>
  ) {
    if (!this._needsUpdatePipeline) {
      return;
    }
    this._needsUpdatePipeline = false;
    const device = this._device;
    const csCode = this._getFullCs(inputParams, inputTypes);
    if (csCode === this._csCode) {
      return;
    }
    this._csCode = csCode;
    this._pipeline = getTargetShaderCache(device).createComputePipeline({
      label: this._label,
      layout: 'auto',
      compute: {
        module: getTargetShaderCache(device).createShaderModule({
          label: this._label,
          code: csCode
        }),
        entryPoint: 'main'
      }
    });
    this._updateBindGroups();
  }

  private _getFullCs(
    inputParams: Record<string, WGPUComputePassInput>,
    inputTypes: Record<string, 'texture' | 'buffer'>
  ) {
    const inputs = this._inputs;
    const uniforms = this._uniforms;
    let offset = 0;
    const groupOffsets = (this._groupOffsets = {
      inputs: 0,
      uniforms: 0,
      outputs: 0
    });
    const workgroupSize = this._getActualWorkgroupSize();

    if (inputs.length > 0) {
      offset++;
    }
    if (uniforms.length > 0) {
      groupOffsets.uniforms = offset;
      offset++;
    }

    function getTypeCode(params: WGPUComputePassOutput) {
      const { type = 'f32', channels } = params;
      let code = channels === 1 ? type : `vec${channels}${type[0]}`;
      if (params.atomic) {
        code = `atomic<${code}>`;
      }
      return code;
    }
    groupOffsets.outputs = offset;
    const cs = `
${inputs
  .sort()
  .map((inputName, idx) => {
    const bindingPrefix = `@group(${groupOffsets.inputs}) @binding(${idx}) `;
    const varName = `in_${inputName}`;
    // TODO more channels option.
    return inputTypes[inputName] === 'texture'
      ? `${bindingPrefix} var ${varName}: texture_2d<f32>;`
      : `${bindingPrefix} var<storage, read> ${varName}: array<${getTypeCode(
          inputParams[inputName]
        )}>;`;
  })
  .join('\n')}
${this._uniforms
  .map(
    (uniform, idx) =>
      `@group(${groupOffsets.uniforms}) @binding(${idx}) var<uniform> ${uniform.label}: ${uniform.type};`
  )
  .join('\n')}

${this._outputs
  .map((name, idx) => {
    return `@group(${
      groupOffsets.outputs
    }) @binding(${idx}) var<storage, read_write> out_${name}: array<${getTypeCode(
      this._outputParams[name] || {}
    )}>;`;
  })
  .join('\n')}
${this._csDefine ?? ''}
@compute @workgroup_size(${workgroupSize[0]}, ${workgroupSize[1]}, 1)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
${this._csMain}
}
`;

    return cs;
  }

  private _updateBindGroups() {
    const bindGroups: GPUBindGroup[] = [];
    const device = this._device;
    const groupOffsets = this._groupOffsets;

    if (this._uniforms.length > 0) {
      bindGroups[groupOffsets.uniforms] = device.createBindGroup({
        label: this._label + '.uniforms',
        layout: this._pipeline.getBindGroupLayout(groupOffsets.uniforms),
        entries: this._uniforms.map(
          (uniform, idx) =>
            ({
              binding: idx,
              resource: {
                buffer: this._uniformBuffers[uniform.label]
              }
            } as GPUBindGroupEntry)
        )
      });
    }

    this._bindGroups = bindGroups;
  }

  createPass(
    commandEncoder: GPUCommandEncoder,
    inputs: Record<I, WGPUComputePassInput>,

    /**
     * Explict outputs. Used for buffers reuse.
     */
    outputs?: Record<O, GPUBuffer>
  ) {
    this._updateOutputBuffers(Object.keys(outputs || {}));
    const outputBuffers = {
      ...this._outputBuffers,
      ...outputs
    } as Record<string, GPUBuffer>;

    const inputTypes = this._inputs.reduce((obj, inputName) => {
      obj[inputName] = inputs[inputName as I].buffer ? 'buffer' : 'texture';
      return obj;
    }, {} as Record<string, 'texture' | 'buffer'>);

    this._updatePipeline(inputs, inputTypes);

    const groupOffsets = this._groupOffsets;
    if (this._inputs.length > 0) {
      this._bindGroups[groupOffsets.inputs] = this._device.createBindGroup({
        label: this._label + '.inputs',
        layout: this._pipeline.getBindGroupLayout(groupOffsets.inputs),
        entries: this._inputs.map((inputName, idx) => ({
          binding: idx,
          resource: inputs[inputName as I].buffer
            ? {
                buffer: inputs[inputName as I].buffer!
              }
            : inputs[inputName as I].texture!.createView()
        }))
      });
    }

    // Outputs
    this._bindGroups[groupOffsets.outputs] = this._device.createBindGroup({
      label: this._label + '.outputs',
      layout: this._pipeline.getBindGroupLayout(groupOffsets.outputs),
      entries: this._outputs.map((bufferName, idx) => ({
        binding: idx,
        resource: {
          buffer: outputBuffers[bufferName]
        }
      }))
    });

    // Begin the render pass
    const computePass = commandEncoder.beginComputePass();

    // Draw a full quad
    computePass.setPipeline(this._pipeline);
    // Bind groups
    this._bindGroups.forEach((bindGroup, idx) => {
      computePass.setBindGroup(idx, bindGroup);
    });

    const workgroupSize = this._getActualWorkgroupSize();
    computePass.dispatchWorkgroups(
      Math.ceil((this._execWidth ?? this._width) / workgroupSize[0]),
      Math.ceil((this._execHeight ?? this._height) / workgroupSize[1]),
      1
    );
    // End the render pass
    computePass.end();
  }
}
