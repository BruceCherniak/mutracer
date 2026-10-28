import { sunPosition } from '../scene/skyParameters.js';
import type { ProceduralEnvironmentSource } from './envMapDistribution.js';
import { SUN_RADIUS } from './skyModel.js';
import { proceduralSkyWGSL } from './wgsl/proceduralSky.compute.js';

type Pass = 'transmittance' | 'multiple' | 'skyView' | 'irradiance' | 'map';

/** Renders into the pipeline's own environment/background texture on its device. */
export class WGPUSkyBaker {
  private readonly tables: Record<Exclude<Pass, 'map'>, GPUTexture>;
  private readonly uniforms: GPUBuffer[];
  private readonly pipelines: Record<Pass, GPUComputePipeline>;
  private readonly inputs: Record<Pass, number[]> = { transmittance: [], multiple: [1, 2], skyView: [1, 2, 4], irradiance: [1, 3], map: [3, 4] };
  private time?: number;

  constructor(private readonly device: GPUDevice) {
    const texture = (label: string, width: number, height: number) => device.createTexture({
      label, size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
    });
    this.tables = {
      transmittance: texture('Sky transmittance', 256, 64), multiple: texture('Sky multiple scattering', 32, 1),
      skyView: texture('Sky view', 96, 192), irradiance: texture('Sky irradiance', 2, 1)
    };
    this.uniforms = [0, 1].map(() => device.createBuffer({ label: 'Sky parameters', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const module = device.createShaderModule({ label: 'Procedural sky', code: proceduralSkyWGSL });
    this.pipelines = {} as Record<Pass, GPUComputePipeline>;
    for (const pass of Object.keys(this.inputs) as Pass[]) {
      const layout = device.createBindGroupLayout({ entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...this.inputs[pass].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' as const } })),
        { binding: 5, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba32float' } }
      ] });
      this.pipelines[pass] = device.createComputePipeline({ label: `Sky ${pass}`, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: pass } });
    }
  }

  bake(source: ProceduralEnvironmentSource, output: GPUTexture) {
    const { width, height, sky, intensity, ambient } = source;
    if (width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) {
      throw new RangeError('ProceduralSky resolution exceeds the device texture size limit.');
    }
    const { elevation, azimuth } = sunPosition(sky.time);
    const e = elevation * Math.PI / 180, a = azimuth * Math.PI / 180;
    const data = new Float32Array([
      Math.cos(e), Math.sin(e), 0, a,
      Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a), SUN_RADIUS * Math.PI / 180,
      width, height, 0, 0,
      intensity, intensity, intensity, 1,
      ...ambient, 0
    ]);
    this.device.queue.writeBuffer(this.uniforms[0], 0, data);
    data[11] = 1;
    this.device.queue.writeBuffer(this.uniforms[1], 0, data);
    const encoder = this.device.createCommandEncoder({ label: 'Procedural sky' });
    const draw = (name: Pass, target: GPUTexture, ground = false) => {
      const pipeline = this.pipelines[name];
      const inputs: Record<number, GPUTexture> = {
        1: this.tables.transmittance, 2: name === 'multiple' ? this.tables.transmittance : this.tables.multiple,
        3: this.tables.skyView, 4: this.tables.irradiance
      };
      const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.uniforms[ground ? 1 : 0] } },
        ...this.inputs[name].map(binding => ({ binding, resource: inputs[binding].createView() })),
        { binding: 5, resource: target.createView() }
      ] });
      const pass = encoder.beginComputePass({ label: `Sky ${name}` });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(target.width / 8), Math.ceil(target.height / 8)); pass.end();
    };
    if (this.time === undefined) draw('transmittance', this.tables.transmittance);
    if (this.time !== sky.time) {
      draw('multiple', this.tables.multiple);
      draw('skyView', this.tables.skyView);
      draw('irradiance', this.tables.irradiance);
      draw('skyView', this.tables.skyView, true);
    }
    draw('map', output, true);
    this.device.queue.submit([encoder.finish()]);
    this.time = sky.time;
  }

  dispose() {
    Object.values(this.tables).forEach(texture => texture.destroy());
    this.uniforms.forEach(buffer => buffer.destroy());
  }
}
