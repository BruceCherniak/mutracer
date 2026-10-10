import { fullScreenQuadVertexShaderWGSL } from './WGPUFullQuadPass.js';

export function createNormalizeRayTraceOutputWGSL() {
  return /* wgsl */ `
@group(0) @binding(0) var<storage, read> colorBuffer: array<vec4f>;
@group(0) @binding(1) var<storage, read> normalBuffer: array<vec4f>;
@group(0) @binding(2) var<storage, read> albedoBuffer: array<vec4f>;
@group(0) @binding(3) var<storage, read> shadowCatcherBuffer: array<vec4f>;

@group(1) @binding(0) var<uniform> sampleCount: f32;
@group(1) @binding(1) var<uniform> sampleTileGrid: vec2u;

override outputWidth: f32;
override outputHeight: f32;

struct FSOutput {
  @location(0) color: vec4f,
  @location(1) normal: vec4f,
  @location(2) albedo: vec4f,
  @location(3) shadowCatcher: vec4f
}
@fragment
fn main(@builtin(position) coord: vec4f) -> FSOutput {
  let size = vec2u(u32(outputWidth), u32(outputHeight));
  let pixel = vec2u(u32(coord.x), size.y - u32(coord.y) - 1u);
  var idx = pixel.x + pixel.y * size.x;
  // Tiles are interleaved pixel grids, not contiguous rectangles. The first
  // tile samples (0, 0) of every grid cell across the current camera image.
  // Reconstruct only pixels not yet sampled, until the first sweep completes;
  // never write these display estimates back into the accumulated ray buffers.
  if (sampleCount < 1.0 && normalBuffer[idx].a <= 0.0) {
    let grid = max(sampleTileGrid, vec2u(1u));
    let nearest = min(
      ((pixel + grid / 2u) / grid) * grid,
      ((size - vec2u(1u)) / grid) * grid
    );
    let nearestIdx = nearest.x + nearest.y * size.x;
    if (normalBuffer[nearestIdx].a > 0.0) {
      idx = nearestIdx;
    }
  }
  var output: FSOutput;
  if (normalBuffer[idx].a <= 0.0) {
    output.color = vec4f(0.0);
    output.normal = vec4f(0.0);
    output.albedo = vec4f(0.0);
    output.shadowCatcher = vec4f(0.0);
    return output;
  }
  let color = colorBuffer[idx];
  let normal = normalBuffer[idx];
  let albedo = albedoBuffer[idx];
  let hit = albedo.a;
  // The CPU count covers completed sweeps and is still zero during the first
  // interleaved sample. Use the actual per-pixel count, including for misses.
  // Empty pixels must remain finite: NaN alpha can poison float HDR output
  // even when its canvas uses opaque compositing.
  let total = max(normal.a, 1.0);
  output.color = vec4f(
    // average the color by hit count.
    // So the antialised edge color will be correct when having transparent background
    color.rgb / select(total, hit, hit > 0.0),
    color.a / total
  );

  output.normal = vec4f(0.0);
  // Normalize to 0 - 1
  if (dot(normal.rgb, normal.rgb) > 0.1) {
    output.normal = vec4f(normal.rgb / total * 0.5 + 0.5, 1.0);
  }
  output.albedo = vec4f(albedo.rgb / total, clamp(hit / total, 0.0, 1.0));
  output.shadowCatcher = shadowCatcherBuffer[idx] / total;
  return output;
}
`;
}

export class WGPURayTraceOutputPass {
  private _device: GPUDevice;

  private _pipeline!: GPURenderPipeline;
  private _colorTexture!: GPUTexture;
  private _normalTexture!: GPUTexture;
  private _albedoTexture!: GPUTexture;
  private _shadowCatcherTexture!: GPUTexture;
  private _uniformBindGroup!: GPUBindGroup;

  private _uniformsBuffers;

  private _width = 1;
  private _height = 1;

  private _needsUpdatePipeline = true;

  constructor(device: GPUDevice) {
    this._device = device;
    this._uniformsBuffers = {
      sampleCount: device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }),
      sampleTileGrid: device.createBuffer({
        size: 8,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      })
    };
  }

  getOutput(label: 'color' | 'normal' | 'albedo' | 'shadowCatcher'): GPUTexture;
  getOutput(
    label:
      | 'color'
      | 'normal'
      | 'albedo'
      | 'shadowCatcher'
  ): GPUTexture | undefined {
    return this[`_${label}Texture`];
  }

  _createTextures() {
    const { _device: device, _width: width, _height: height } = this;
    const textureDescriptor: GPUTextureDescriptor = {
      size: {
        width,
        height,
        depthOrArrayLayers: 1
      },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC
    };
    this._destroyTextures();
    this._colorTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Color',
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC
    });
    this._normalTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Normal',
      usage: textureDescriptor.usage | GPUTextureUsage.COPY_SRC
    });
    this._albedoTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Albedo'
    });
    this._shadowCatcherTexture = device.createTexture({
      ...textureDescriptor,
      label: 'Ray Trace Shadow Catcher'
    });
  }

  _updateBindGroups() {
    const device = this._device;
    this._uniformBindGroup = device.createBindGroup({
      layout: this._pipeline.getBindGroupLayout(1),
      entries: [
        {
          binding: 0,
          resource: {
            buffer: this._uniformsBuffers.sampleCount
          }
        },
        {
          binding: 1,
          resource: {
            buffer: this._uniformsBuffers.sampleTileGrid
          }
        }
      ]
    });
  }

  _updatePipeline() {
    if (!this._needsUpdatePipeline) {
      return;
    }
    this._needsUpdatePipeline = false;
    const device = this._device;

    this._pipeline = device.createRenderPipeline({
      label: 'rayTraceOutput',
      layout: 'auto',
      vertex: {
        module: device.createShaderModule({
          code: fullScreenQuadVertexShaderWGSL
        }),
        entryPoint: 'main'
      },
      fragment: {
        module: device.createShaderModule({
          code: createNormalizeRayTraceOutputWGSL()
        }),
        entryPoint: 'main',
        targets: [
          {
            format: 'rgba16float'
          },
          {
            format: 'rgba8unorm'
          },
          {
            format: 'rgba8unorm'
          },
          {
            format: 'rgba8unorm'
          }
        ],
        constants: {
          outputWidth: this._width,
          outputHeight: this._height
        }
      }
    });

    this._updateBindGroups();
  }

  setSize(width: number, height: number) {
    if (
      this._width !== width ||
      this._height !== height ||
      !this._colorTexture
    ) {
      this._width = width;
      this._height = height;
      this._createTextures();
      this._needsUpdatePipeline = true;
    }
  }

  setSampleCount(sampleCount: number) {
    this._device.queue.writeBuffer(
      this._uniformsBuffers.sampleCount,
      0,
      new Float32Array([sampleCount])
    );
  }

  setSampleTileGrid(columns: number, rows: number) {
    this._device.queue.writeBuffer(
      this._uniformsBuffers.sampleTileGrid,
      0,
      new Uint32Array([columns, rows])
    );
  }

  createPass(
    encoder: GPUCommandEncoder,
    inputBuffers: {
      color: GPUBuffer;
      normal: GPUBuffer;
      albedo: GPUBuffer;
      shadowCatcher: GPUBuffer;
      shadowCatcherOffset?: number;
    }
  ) {
    this._updatePipeline();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        this._colorTexture,
        this._normalTexture,
        this._albedoTexture,
        this._shadowCatcherTexture
      ].map((texture) => ({
        view: texture.createView(),
        loadValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
        loadOp: 'clear'
      }))
    });
    pass.setPipeline(this._pipeline);

    pass.setBindGroup(
      0,
      this._device.createBindGroup({
        label: 'rayTraceOutput',
        layout: this._pipeline.getBindGroupLayout(0),
        entries: [
          inputBuffers.color,
          inputBuffers.normal,
          inputBuffers.albedo,
          inputBuffers.shadowCatcher
        ].map((buffer, idx) => ({
          binding: idx,
          resource: {
            buffer,
            ...(idx === 3 ? { offset: inputBuffers.shadowCatcherOffset ?? 0 } : {})
          }
        }))
      })
    );
    pass.setBindGroup(1, this._uniformBindGroup);

    pass.draw(6, 1, 0, 0);
    pass.end();

  }

  private _destroyTextures() {
    if (!this._colorTexture) return;

    // These textures are also OIDN inputs. A resolution or preview-mode
    // change can replace them immediately after a denoising command buffer
    // was submitted. Keep the old resources alive until all work submitted so
    // far has completed; destroying them synchronously can make Dawn validate
    // the pending submit against an already-destroyed texture.
    const textures = [
      this._colorTexture,
      this._normalTexture,
      this._albedoTexture,
      this._shadowCatcherTexture
    ].filter((texture): texture is GPUTexture => !!texture);
    void this._device.queue
      .onSubmittedWorkDone()
      .catch(() => undefined)
      .then(() => textures.forEach((texture) => texture.destroy()));
  }

  dispose() {
    this._destroyTextures();
    Object.keys(this._uniformsBuffers).forEach((key) => {
      (this._uniformsBuffers as any)[key].destroy();
    });
  }
}
