/** Small renderer-owned caches. Keys include exact source and GPU object identity;
 * resources/bind groups are deliberately never retained here. */
export class WGPUShaderCache {
  private modules = new Map<string, GPUShaderModule>();
  private bindGroupLayouts = new Map<string, GPUBindGroupLayout>();
  private layouts = new Map<string, GPUPipelineLayout>();
  private pipelines = new Map<string, Promise<GPUComputePipeline>>();
  private ids = new WeakMap<object, number>();
  private nextId = 0;

  constructor(private device: GPUDevice) {}

  private id(value: object) {
    let id = this.ids.get(value);
    if (id === undefined) {
      id = ++this.nextId;
      this.ids.set(value, id);
    }
    return id;
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
    return value;
  }

  createShaderModule(descriptor: Pick<GPUShaderModuleDescriptor, 'code' | 'label'>) {
    const key = descriptor.code;
    return this.remember(this.modules, key,
      this.modules.get(key) ?? this.device.createShaderModule(descriptor), 8);
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor) {
    const entries = Array.from(descriptor.entries);
    const key = JSON.stringify(entries);
    return this.remember(this.bindGroupLayouts, key,
      this.bindGroupLayouts.get(key) ??
        this.device.createBindGroupLayout({ ...descriptor, entries }), 32);
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor) {
    const bindGroupLayouts = Array.from(descriptor.bindGroupLayouts);
    const { bindGroupLayouts: _groups, label: _label, ...options } = descriptor;
    const key = JSON.stringify([options,
      bindGroupLayouts.map((layout) => layout == null ? null : this.id(layout))]);
    return this.remember(this.layouts, key,
      this.layouts.get(key) ??
        this.device.createPipelineLayout({ ...descriptor, bindGroupLayouts }), 16);
  }

  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor) {
    const { compute, layout } = descriptor;
    const key = JSON.stringify([
      this.id(compute.module),
      layout === 'auto' ? 'auto' : this.id(layout),
      compute.entryPoint,
      Object.entries(compute.constants ?? {}).sort(([a], [b]) => a.localeCompare(b))
    ]);
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = this.device.createComputePipelineAsync(descriptor);
      const pending = pipeline;
      // A failed/in-flight request must not poison a later retry. The identity
      // guard also avoids deleting a replacement after LRU eviction.
      void pending.catch(() => {
        if (this.pipelines.get(key) === pending) this.pipelines.delete(key);
      });
    }
    return this.remember(this.pipelines, key, pipeline, 128);
  }

  clear() {
    this.modules.clear();
    this.bindGroupLayouts.clear();
    this.layouts.clear();
    this.pipelines.clear();
  }
}

/** Grow in coarse buckets; scene edits must not shrink a compiled stack. */
export function retainedShaderCapacity(required: number, previous = 0, minimum = 8) {
  return Math.max(previous, minimum, 2 ** Math.ceil(Math.log2(Math.max(1, required))));
}
