import {scratchWGSLFunctions} from './scratchSampling.js';
import {setTextureRegion, textureRegion} from './textureRegion.js';
import { getTargetShaderCache } from './WGPUShaderCache.js';
import { textureBytes } from './gpuMemory.js';
export const fullScreenQuadVertexShaderWGSL = /*wgsl */ `
@vertex
fn main(
  @builtin(vertex_index) vertexIndex: u32
) -> @builtin(position) vec4f {
  const pos = array(
    vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
    vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  );

  return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
}
`;

function isTextureParamsEqual(
  params: WGPUFullQuadPassOutput,
  other: WGPUFullQuadPassOutput
) {
  return params.format === other.format;
}

export function getUniformBuffer(
  value: any,
  type: Uniform['type']
): Float32Array | Int32Array | Uint32Array {
  if (
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array
  ) {
    return value;
  }

  if (typeof value === 'number') {
    value = [value];
  }

  if (type === 'i32' || type.endsWith('i')) {
    return new Int32Array(value);
  } else if (type === 'u32' || type.endsWith('u')) {
    return new Uint32Array(value);
  } else {
    return new Float32Array(value);
  }
}

export interface Uniform {
  label: string;
  type:
    | `array<vec4u, ${number}>`
    | 'f32'
    | 'i32'
    | 'u32'
    | 'vec3f'
    | 'vec4f'
    | 'vec2f'
    | 'vec2i'
    | 'vec3i'
    | 'vec4i'
    | 'vec2u'
    | 'vec3u'
    | 'vec4u';
  data: Float32Array | Int32Array | Uint32Array | number | number[];
}

export interface WGPUFullQuadPassOutput {
  format: GPUTextureFormat;
}
export class WGPUFullQuadPass<I extends string, O extends string> {
  private _label;

  private _device;
  private _outputTextures: Record<string, GPUTexture> = {};
  private _outputParams: Record<string, WGPUFullQuadPassOutput> = {};

  private _pipeline!: GPURenderPipeline;
  private _bindGroups: GPUBindGroup[] = [];
  private _needsUpdatePipeline = true;
  private _needsUpdateOutputTextures = true;
  /**
   * When render to canvas
   */
  private _renderToScreen?: {
    screenTexture: GPUTexture;
    presentationFormat: GPUTextureFormat;
  };
  private _inputs: string[] = [];
  private _inputViewDimensions: Partial<
    Record<I, GPUTextureViewDimension>
  > = {};
  private _outputs: string[] = [];
  private _uniforms: Uniform[] = [];
  private _uniformsMap: Record<string, Uniform> = {};
  private _uniformBuffers: Record<string, GPUBuffer> = {};

  private _samplers: Record<string, GPUSampler> = {};

  private _capacityWidth = 0;
  private _capacityHeight = 0;
  private _reserveCapacity = false;
  private _regionNames: string[] = [];
  private _width = 10;
  private _height = 10;

  private _fsCode = '';
  private readonly _fsMain;
  private readonly _fsDefine;

  private _textureWillBeRead;

  constructor(
    label: string,
    device: GPUDevice,
    opts: {
      inputs: I[];
      inputViewDimensions?: Partial<Record<I, GPUTextureViewDimension>>;
      outputs: O[];
      samplers?: Record<string, GPUSampler>;
      fsMain: string;
      fsDefine?: string;
      uniforms?: Uniform[];
      textureWillBeRead?: boolean;
    }
  ) {
    this._label = label;
    this._device = device;
    this._fsMain = opts.fsMain;
    this._fsDefine = opts.fsDefine;
    this._inputs = opts.inputs;
    this._inputViewDimensions = opts.inputViewDimensions || {};
    this._outputs = opts.outputs;
    this._uniforms = (opts.uniforms || []).concat({
      label: 'viewportSize',
      type: 'vec2f',
      data: [0, 0]
    });
    this._samplers = opts.samplers || {};
    this._uniformsMap = this._uniforms.reduce((map, uniform) => {
      map[uniform.label] = uniform;
      return map;
    }, {} as Record<string, Uniform>);
    this._textureWillBeRead = opts.textureWillBeRead || false;

    this._uniforms.forEach((uniform) => {
      const data = getUniformBuffer(uniform.data, uniform.type);
      this._uniformBuffers[uniform.label] = device.createBuffer({
        label: this._label,
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

  /** Keep physical outputs large enough for every render while varying the logical viewport. */
  reserveCapacity() {
    if (this._reserveCapacity) return;
    this._reserveCapacity = true;
    this._capacityWidth = this._width; this._capacityHeight = this._height;
    const textures = this._inputs.filter(name => !this._inputViewDimensions[name as I] || this._inputViewDimensions[name as I] === '2d');
    this._regionNames = textures;
    if (textures.length) {
      const uniform: Uniform = {label: 'imageRegions', type: `array<vec4u, ${textures.length}>`, data: new Uint32Array(textures.length * 4)};
      this._uniforms.push(uniform); this._uniformsMap[uniform.label] = uniform;
      this._uniformBuffers[uniform.label] = this._device.createBuffer({label: `${this._label}.${uniform.label}`, size: textures.length * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
    }
    this._needsUpdatePipeline = true; this._fsCode = '';
  }
  setSize(width: number, height: number) {
    width = Math.max(1, Math.ceil(width));
    height = Math.max(1, Math.ceil(height));
    const sizeChanged = width !== this._width || height !== this._height;
    this._width = width;
    this._height = height;
    if (sizeChanged) {
      const nextWidth = Math.max(this._capacityWidth, width);
      const nextHeight = Math.max(this._capacityHeight, height);
      this._needsUpdateOutputTextures ||= !this._reserveCapacity || nextWidth !== this._capacityWidth || nextHeight !== this._capacityHeight;
      this._capacityWidth = nextWidth; this._capacityHeight = nextHeight;
      this._needsUpdatePipeline = true;

      this.setUniform('viewportSize', [width, height]);
    }
  }

  setOutputParams(outputParams: Record<O, WGPUFullQuadPassOutput>) {
    const wasScreen = !!this._renderToScreen;
    this._renderToScreen = undefined;
    const outputsChanged = Object.keys(outputParams).some(
      (key) =>
        !isTextureParamsEqual(
          (outputParams as any)[key],
          this._outputParams[key] || ({} as WGPUFullQuadPassOutput)
        )
    );
    this._needsUpdateOutputTextures ||= outputsChanged;
    this._needsUpdatePipeline ||= outputsChanged || wasScreen;
    if (outputsChanged || wasScreen) this._fsCode = '';
    this._outputParams = outputParams;
  }

  setRenderToScreen(
    screenTexture: GPUTexture,
    presentationFormat: GPUTextureFormat
  ) {
    if (
      !this._renderToScreen ||
      this._renderToScreen.presentationFormat !== presentationFormat
    ) {
      this._needsUpdatePipeline = true;
      this._fsCode = '';
    }
    this._renderToScreen = {
      screenTexture,
      presentationFormat
    };
  }

  setUniform(label: string, data: Uniform['data']) {
    const buffer = this._uniformBuffers[label];
    this._device.queue.writeBuffer(
      buffer,
      0,
      getUniformBuffer(data, this._uniformsMap[label].type)
    );
  }

  private readonly _retainedOutputs = new Set<GPUTexture>();
  retainOutput(texture: GPUTexture) { if (Object.values(this._outputTextures).includes(texture)) this._retainedOutputs.add(texture); }
  releaseOutput(texture: GPUTexture) {
    if (!this._retainedOutputs.delete(texture)) return;
    if (!Object.values(this._outputTextures).includes(texture)) {
      void this._device.queue.onSubmittedWorkDone().catch(() => undefined).then(() => texture.destroy());
    }
  }

  getOutput(name: O) {
    return this._outputTextures[name];
  }

  getMemoryBytes() {
    return Object.values(this._uniformBuffers).reduce((sum, buffer) => sum + buffer.size, 0)
      + Array.from(new Set([...Object.values(this._outputTextures), ...this._retainedOutputs]))
        .reduce((sum, texture) => sum + textureBytes(texture), 0);
  }

  dispose() {
    Object.keys(this._uniformBuffers).forEach((key) => {
      (this._uniformBuffers as any)[key].destroy();
    });
    new Set([...Object.values(this._outputTextures), ...this._retainedOutputs]).forEach(texture => texture.destroy());
    this._retainedOutputs.clear();
  }

  private _createTexture(params: WGPUFullQuadPassOutput) {
    return this._device.createTexture({
      label: this._label,
      size: {
        width: this._reserveCapacity ? this._capacityWidth : this._width,
        height: this._reserveCapacity ? this._capacityHeight : this._height,
        depthOrArrayLayers: 1
      },
      format: params.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        (this._textureWillBeRead ? GPUTextureUsage.COPY_SRC : 0)
    });
  }

  private _updateOutputTextures(excludes?: string[]) {
    const outputParams = this._outputParams;
    for (const key in outputParams) {
      if (excludes?.includes(key)) {
        continue;
      }
      const params = outputParams[key];
      if (!this._retainedOutputs.has(this._outputTextures[key])) this._outputTextures[key]?.destroy();
      this._outputTextures[key] = this._createTexture(params);
    }
  }

  private _updatePipeline() {
    if (!this._needsUpdatePipeline) {
      return;
    }
    this._needsUpdatePipeline = false;

    const outputParams = this._outputParams;
    const device = this._device;
    const fsCode = this._getFullFs();
    if (fsCode === this._fsCode) {
      return;
    }
    const { screenTexture, presentationFormat } = this._renderToScreen || {};
    this._fsCode = fsCode;
    this._pipeline = getTargetShaderCache(device).createRenderPipeline({
      label: this._label,
      layout: 'auto',
      vertex: {
        module: getTargetShaderCache(device).createShaderModule({
          label: this._label,
          code: fullScreenQuadVertexShaderWGSL
        }),
        entryPoint: 'main'
      },
      fragment: {
        module: getTargetShaderCache(device).createShaderModule({
          label: this._label,
          code: fsCode
        }),
        entryPoint: 'main',
        targets: screenTexture
          ? [
              {
                format: presentationFormat!
              }
            ]
          : this._outputs.map((key) => ({
              format: (outputParams as any)[key].format
            }))
      },
      primitive: {
        topology: 'triangle-list'
      }
    });
    this._updateBindGroups();
  }

  private _getFullFs() {
    const inputs = this._inputs;
    const inputsLen = inputs.length;
    const hasInputs = inputsLen > 0;
    const fs = /* wgsl */ `
${inputs
  .sort()
  .map(
    (textureName, idx) => {
      const viewDimension = this._inputViewDimensions[textureName as I];
      const textureType = viewDimension === '3d' ? 'texture_3d' : 'texture_2d';
      return `@group(0) @binding(${idx}) var ${textureName}: ${textureType}<f32>;`;
    }
  )
  .join('\n')}

${
  hasInputs
    ? Object.keys(this._samplers)
        .sort()
        .map(
          (samplerName, idx) =>
            `@group(0) @binding(${
              idx + inputsLen
            }) var ${samplerName}: sampler;`
        )
        .join('\n')
    : ''
}
${this._uniforms
  .map(
    (uniform, idx) =>
      `@group(${hasInputs ? 1 : 0}) @binding(${idx}) var<uniform> ${
        uniform.label
      }: ${uniform.type};`
  )
  .join('\n')}
struct FSOutput {
${this._outputs
  .map((name, idx) => `@location(${idx}) ${name}: vec4f,`)
  .join('\n')}
}
${scratchWGSLFunctions(
  this._reserveCapacity ? this._regionNames : inputs.filter(name =>
    !this._inputViewDimensions[name as I] || this._inputViewDimensions[name as I] === '2d'),
  Object.keys(this._samplers), this._reserveCapacity
)}
${this._fsDefine ?? ''}
@fragment
fn main(
  @builtin(position) coord: vec4f
) -> FSOutput {
  let uv = vec2i(floor(coord.xy));
  let uv2 = coord.xy / viewportSize;
  var output: FSOutput;
${this._fsMain}
  return output;
}
`;

    return fs;
  }

  private _updateBindGroups() {
    const bindGroups: GPUBindGroup[] = [];
    const device = this._device;
    const uniformBindGroupIndex = this._inputs.length > 0 ? 1 : 0;
    if (this._uniforms.length > 0) {
      bindGroups[uniformBindGroupIndex] = device.createBindGroup({
        label: this._label,
        layout: this._pipeline.getBindGroupLayout(uniformBindGroupIndex),
        entries: this._uniforms.map(
          (uniform, idx) =>
            ({
              binding: idx,
              resource: {
                buffer: this._uniformBuffers[uniform.label]
              }
            } satisfies GPUBindGroupEntry)
        )
      });
    }

    this._bindGroups = bindGroups;
  }

  createPass(
    commandEncoder: GPUCommandEncoder,
    inputs: Record<I, GPUTexture>,

    /**
     * Explict outputs. Used for buffers reuse.
     */
    outputs?: Record<O, GPUTexture>
  ) {
    if (this._needsUpdateOutputTextures && !this._renderToScreen) {
      this._updateOutputTextures(Object.keys(outputs || {}));
      this._needsUpdateOutputTextures = false;
    }

    if (this._regionNames.length) {
      const values = new Uint32Array(this._regionNames.length * 4);
      for (const [index, name] of this._regionNames.entries()) {
        const region = textureRegion(inputs[name as I]);
        values.set([region.width, region.height], index * 4);
      }
      this.setUniform('imageRegions', values);
    }
    for (const texture of Object.values(this._outputTextures)) setTextureRegion(texture, this._width, this._height);
    this._updatePipeline();

    const inputsLen = this._inputs.length;
    if (inputsLen > 0) {
      this._bindGroups[0] = this._device.createBindGroup({
        label: this._label,
        layout: this._pipeline.getBindGroupLayout(0),
        entries: [
          ...this._inputs.map((textureName, idx) => ({
            binding: idx,
            resource: inputs[textureName as I].createView(
              this._inputViewDimensions[textureName as I]
                ? { dimension: this._inputViewDimensions[textureName as I] }
                : undefined
            )
          })),
          ...Object.keys(this._samplers).map((samplerName, idx) => ({
            binding: idx + inputsLen,
            resource: this._samplers[samplerName]
          }))
        ]
      });
    }

    const outputTextures = {
      // Pick the texture from outputTextures first.
      ...this._outputTextures,
      ...outputs
    } as Record<string, GPUTexture>;
    // Begin the render pass
    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: this._renderToScreen
        ? [
            {
              view: this._renderToScreen.screenTexture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              storeOp: 'store',
              loadOp: 'clear'
            }
          ]
        : this._outputs.map(
            (textureName) =>
              ({
                view: outputTextures[textureName].createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: 'clear',
                storeOp: 'store'
              } satisfies GPURenderPassColorAttachment)
          )
    });

    // Draw a full quad
    renderPass.setViewport(0, 0, this._width, this._height, 0, 1);
    renderPass.setScissorRect(0, 0, this._width, this._height);
    renderPass.setPipeline(this._pipeline);
    // Bind groups
    this._bindGroups.forEach((bindGroup, idx) => {
      renderPass.setBindGroup(idx, bindGroup);
    });
    renderPass.draw(6, 1, 0, 0);
    // End the render pass
    renderPass.end();
  }
}
