// Render the exact capture consumed by Rust, using real browser WebGPU/Dawn.
const status = document.querySelector('#status');
try {
  if (!navigator.gpu) throw new Error('This browser does not expose navigator.gpu');
  const scene = await (await fetch('/scene/scene.json')).json();
  const samples = Number(new URL(location.href).searchParams.get('samples') ?? 256);
  if (!Number.isInteger(samples) || samples < 1 || samples > 4096) throw new Error('Invalid sample count');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No browser WebGPU adapter');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', event => { status.textContent += `\nGPU error: ${event.error.message}`; });
  const read = async name => new Uint8Array(await (await fetch(`/scene/${name}`)).arrayBuffer());
  const buffers = new Map(), textures = new Map(), samplers = new Map();
  for (const input of scene.buffers) {
    const buffer = device.createBuffer({ size: input.size, usage: input.usage | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, await read(input.file));
    buffers.set(input.id, buffer);
  }
  for (const input of scene.textures) {
    const texture = device.createTexture({ size: [input.width, input.height, input.depth],
      format: input.format, usage: input.usage });
    for (const write of input.writes) {
      device.queue.writeTexture({ texture, origin: write.origin }, await read(write.file), write.layout, write.size);
    }
    textures.set(input.id, texture);
  }
  for (const {id, ...descriptor} of scene.samplers) samplers.set(id, device.createSampler(descriptor));
  const layouts = scene.bindGroups.map(group => device.createBindGroupLayout({ entries: group.layout }));
  const source = await (await fetch(`/scene/${scene.shader}`)).text();
  const module = device.createShaderModule({ code: source });
  const pipeline = await device.createComputePipelineAsync({
    layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
    compute: { module, entryPoint: scene.entryPoint }
  });
  const groups = scene.bindGroups.map((group, index) => device.createBindGroup({ layout: layouts[index],
    entries: group.entries.map(entry => ({ binding: entry.binding, resource: entry.kind === 'buffer'
      ? { buffer: buffers.get(entry.id) } : entry.kind === 'texture'
      ? textures.get(entry.id).createView(entry.options) : samplers.get(entry.id) })) }));
  const start = performance.now();
  for (let sample = 0; sample < samples; sample++) {
    device.queue.writeBuffer(buffers.get(scene.rtUniform), 8, new Float32Array([sample]));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(); pass.setPipeline(pipeline);
    groups.forEach((group, index) => pass.setBindGroup(index, group));
    pass.dispatchWorkgroups(Math.ceil(scene.width / 8), Math.ceil(scene.height / 8)); pass.end();
    device.queue.submit([encoder.finish()]);
    if (sample % 16 === 15) {
      await device.queue.onSubmittedWorkDone();
      status.textContent = `Browser WebGPU: ${sample + 1}/${samples} samples`;
    }
  }
  const aovOutputs = [];
  for (const [name, id] of [['hdr', scene.colorOutput], ['normal', scene.normalOutput], ['albedo', scene.albedoOutput]]) {
    if (id === undefined) continue;
    const output = device.createBuffer({ size: scene.width * scene.height * 16,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffers.get(id), 0, output, 0, output.size);
    device.queue.submit([encoder.finish()]); await output.mapAsync(GPUMapMode.READ);
    const floats = new Float32Array(output.getMappedRange().slice(0)); output.unmap();
    for (let i = 0; i < floats.length; i++) {
      floats[i] /= samples;
      if (!Number.isFinite(floats[i])) throw new Error(`Non-finite browser value at ${i}`);
    }
    const posted = await fetch(`/result/${name}`, { method: 'POST', body: floats });
    if (!posted.ok) throw new Error(`Failed saving browser ${name}`);
    aovOutputs.push(name);
    output.destroy();
  }
  const info = { width: scene.width, height: scene.height, samples,
    adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
      device: adapter.info?.device, description: adapter.info?.description },
    renderSeconds: (performance.now() - start) / 1000, finitePixels: scene.width * scene.height,
    aovOutputs, backend: 'browser WebGPU', hdrLayout: 'little-endian f32 RGBA, bottom row first' };
  await fetch('/result/info', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(info) });
  status.textContent = `PASS: browser HDR reference saved\n${JSON.stringify(info, null, 2)}`;
  device.destroy();
} catch (error) {
  status.textContent = `FAIL: ${error.stack ?? error}`;
  await fetch('/result/error', { method: 'POST', body: String(error.stack ?? error) });
}
