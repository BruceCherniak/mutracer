import type {PostProcess} from '@meimu/mutracer';

/** A caller-owned overlay after tone mapping, compatible with every display format. */
export function createCrosshairPass(): PostProcess {
  const devices = new WeakMap<GPUDevice, Map<GPUTextureFormat, GPURenderPipeline>>();
  return ({device, encoder, input, output, width, height}) => {
    let formats = devices.get(device);
    if (!formats) { formats = new Map(); devices.set(device, formats); }
    let pipeline = formats.get(output.format);
    if (!pipeline) {
      const module = device.createShaderModule({code: /* wgsl */ `
@group(0) @binding(0) var image: texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[i], 0, 1);
}
@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let color = textureLoad(image, vec2i(p.xy), 0);
  let distance = abs(p.xy - vec2f(textureDimensions(image)) * .5);
  let crosshair = (distance.x < 1 && distance.y < 8) || (distance.y < 1 && distance.x < 8);
  return select(color, vec4f(1, 1, 1, 1), crosshair);
}`});
      pipeline = device.createRenderPipeline({layout: 'auto', vertex: {module, entryPoint: 'vertex'},
        fragment: {module, entryPoint: 'fragment', targets: [{format: output.format}]}});
      formats.set(output.format, pipeline);
    }
    const pass = encoder.beginRenderPass({colorAttachments: [{view: output.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}]});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: input.createView()}]}));
    pass.setViewport(0, 0, width, height, 0, 1);
    pass.draw(3);pass.end();
  };
}
