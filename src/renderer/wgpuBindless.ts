// Browser-only experimental API boundary. Keep native/shared WGSL types unchanged.
export interface ResourceTable {
  readonly size: number;
  update(slot: number, resource: GPUTextureView | GPUSampler): void;
  destroy(): void;
}
export interface BindlessSupport { feature: GPUFeatureName; enable: string; }
export interface MaterialTextureSelection {
  requested: 'atlas' | 'auto';
  support?: BindlessSupport;
  fallbackReason?: string;
}
type TableDevice = GPUDevice & {createResourceTable(descriptor: {size: number; label?: string}): ResourceTable};
type TablePass = GPUComputePassEncoder & {setResourceTable(table: ResourceTable): void};
export const RESOURCE_TABLE_LIMIT = 65536;
export const FIRST_TEXTURE_SLOT = 10;
export function resourceTableFeature(features: Pick<GPUSupportedFeatures, 'has'>): BindlessSupport | undefined {
  for (const [feature, enable] of [
    ['sampling-resource-table', 'resource_table'],
    ['chromium-experimental-sampling-resource-table', 'chromium_experimental_resource_table']
  ]) if (features.has(feature as GPUFeatureName)) return {feature: feature as GPUFeatureName, enable};
}
export function bindlessLimitReason(device: GPUDevice, count = 0): string | undefined {
  if (device.limits.maxStorageBuffersPerShaderStage < 9) return 'Bindless textures require 9 storage buffers per shader stage.';
  if (count + FIRST_TEXTURE_SLOT > RESOURCE_TABLE_LIMIT) return 'Scene exceeds resource-table slot capacity.';
  const bytes = Math.max(1, count) * 48;
  if (bytes > device.limits.maxStorageBufferBindingSize || bytes > device.limits.maxBufferSize) return 'Texture metadata exceeds device buffer limits.';
}
export function createResourceTable(device: GPUDevice, size: number): ResourceTable {
  return (device as TableDevice).createResourceTable({size, label: 'Material textures'});
}
export function setResourceTable(pass: GPUComputePassEncoder, table: ResourceTable) {
  (pass as TablePass).setResourceTable(table);
}
export function resourceTableLayout(descriptor: GPUPipelineLayoutDescriptor) {
  return {...descriptor, usesResourceTable: true};
}
const probes = new WeakMap<GPUDevice, Promise<string | undefined>>();
export function probeBindless(device: GPUDevice, support: BindlessSupport): Promise<string | undefined> {
  let pending = probes.get(device);
  if (!pending) { pending = runProbe(device, support); probes.set(device, pending); }
  return pending;
}
async function runProbe(device: GPUDevice, support: BindlessSupport): Promise<string | undefined> {
  const reason = bindlessLimitReason(device);
  if (reason) return reason;
  if (typeof (device as TableDevice).createResourceTable !== 'function') return 'Resource-table API is unavailable.';
  let table: ResourceTable | undefined;
  const textures: GPUTexture[] = [];
  const buffers: GPUBuffer[] = [];
  device.pushErrorScope('validation');
  let failure: string | undefined;
  try {
    table = createResourceTable(device, 3);
    for (let i = 0; i < 2; i++) {
      const texture = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
      textures.push(texture);
      device.queue.writeTexture({texture}, new Uint8Array(i ? [0,255,0,255] : [255,0,0,255]), {bytesPerRow: 4}, [1,1]);
      table.update(i, texture.createView());
    }
    table.update(2, device.createSampler({minFilter: 'linear', magFilter: 'linear'}));
    const module = device.createShaderModule({code: `enable ${support.enable};
@group(0) @binding(0) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(2) fn main(@builtin(local_invocation_index) index: u32) {
  let tex = getResource<texture_2d<f32>>(index);
  let samp = getResource<sampler>(2);
  result[index] = textureSampleLevel(tex, samp, vec2f(0.5), 0.0);
}`});
    const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module}});
    const output = device.createBuffer({size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const readback = device.createBuffer({size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    buffers.push(output, readback);
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: output}}]});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); setResourceTable(pass, table); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, 32); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const actual = new Float32Array(readback.getMappedRange());
    if ([1,0,0,1,0,1,0,1].some((value, i) => actual[i] !== value)) failure = 'Resource-table sampling probe returned incorrect pixels.';
    readback.unmap();
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally { table?.destroy(); textures.forEach(t => t.destroy()); buffers.forEach(b => b.destroy()); }
  const error = await device.popErrorScope();
  return failure ?? error?.message;
}
