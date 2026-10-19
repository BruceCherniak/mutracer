// Open on a real WebGPU device. OIDN is WebGPU-only; no network weights needed.
import {WGPUFullQuadPass} from '../../src/renderer/WGPUFullQuadPass.js';
import {composeDefine, composeMain, compositeDenoiseOutputMain} from '../../src/renderer/wgsl/compose.frag.wgsl.js';

export async function capture() {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('A real WebGPU adapter is required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
  const size = 16;
  const textures: GPUTexture[] = [];
  const texture = (rgba: number[]) => {
    const texture = device.createTexture({size: [size, size], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
    const data = new Float32Array(size * size * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    device.queue.writeTexture({texture}, data, {bytesPerRow: size * 16}, [size, size]);
    textures.push(texture);
    return texture;
  };
  const pass = new WGPUFullQuadPass('Composed denoising guide regression', device, {
    textureWillBeRead: true, fsDefine: composeDefine, fsMain: composeMain + compositeDenoiseOutputMain,
    inputs: ['colorTex', 'foregroundTex', 'catcherBackgroundTex', 'flatBackgroundMaskTex', 'shadowCatcherTex', 'bloomTex'],
    outputs: ['color', 'denoiseColor', 'denoiseAlbedo'],
    uniforms: [
      {label: 'exposure', type: 'f32', data: 1},
      {label: 'toneMappingParams', type: 'vec2f', data: [4, 0]},
      {label: 'hdrOutputEnabled', type: 'f32', data: 0},
      {label: 'colorGradingParams', type: 'vec4f', data: [1, 1, 0, 0]},
      {label: 'flatBackgroundColor', type: 'vec4f', data: [0, 0, 0, 0]},
      {label: 'shadowCatcherColor', type: 'vec3f', data: [0, 0, 0]},
      {label: 'shadowCatcherAlpha', type: 'f32', data: 1},
      {label: 'shadowCatcherEnabled', type: 'f32', data: 1},
      {label: 'bloomIntensity', type: 'f32', data: 0}
    ]
  });
  pass.setSize(size, size);
  pass.setOutputParams({color: {format: 'rgba8unorm'}, denoiseColor: {format: 'rgba32float'}, denoiseAlbedo: {format: 'rgba8unorm'}});
  const surface = [.8, .55, .45];
  const background = [.2, .4, .6];
  const cases = [
    {name: 'foreground', coverage: 0, shadow: 0},
    {name: 'receiver', coverage: 1, shadow: 0},
    {name: 'shadow', coverage: 1, shadow: .8},
    {name: 'mixed coverage', coverage: .5, shadow: .8},
    {name: 'bloom', coverage: 1, shadow: .8, bloom: 2},
    {name: 'transparent background', coverage: 1, shadow: .8, alpha: 0},
    {name: 'flat background', coverage: 1, shadow: .8, flat: true},
    {name: 'exposure', coverage: 1, shadow: 0, exposure: 2}
  ];
  const results = [];
  try {
    for (const entry of cases) {
      const {coverage, shadow} = entry;
      const alpha = entry.alpha ?? 1;
      const albedo = surface.map(v => v * (1 - coverage) + coverage);
      pass.setUniform('bloomIntensity', entry.bloom ?? 0);
      pass.setUniform('flatBackgroundColor', entry.flat ? [.3, .3, .3, 1] : [0, 0, 0, 0]);
      pass.setUniform('exposure', entry.exposure ?? 1);
      const encoder = device.createCommandEncoder();
      pass.createPass(encoder, {
        colorTex: texture([.3, .3, .3, 1]),
        foregroundTex: texture([.3, .3, .3, 1 - coverage]),
        catcherBackgroundTex: texture([...background.map(v => v * coverage * alpha), coverage * alpha]),
        flatBackgroundMaskTex: texture([...albedo, .75]),
        shadowCatcherTex: texture([coverage, 0, 0, shadow * coverage]),
        bloomTex: texture([.1, .1, .1, 0])
      });
      const buffer = device.createBuffer({size: size * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      encoder.copyTextureToBuffer({texture: pass.getOutput('denoiseAlbedo')}, {buffer, bytesPerRow: 256}, [size, size]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(buffer.getMappedRange());
      const expected = albedo.map((v, ch) => entry.flat || alpha === 0 ? v : v + coverage * (Math.min(1, background[ch] * (entry.exposure ?? 1)) - 1));
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let ch = 0; ch < 4; ch++) {
        const want = ch === 3 ? .75 : expected[ch];
        if (Math.abs(data[y * 256 + x * 4 + ch] / 255 - want) > 1.01 / 255) throw new Error(`${entry.name}: wrong guide at ${x},${y},${ch}`);
      }
      results.push({name: entry.name, albedo: Array.from(data.subarray(0, 4))});
      buffer.unmap(); buffer.destroy();
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return {adapter: (adapter as GPUAdapter & {info?: GPUAdapterInfo}).info?.vendor, results};
  } finally {pass.dispose(); textures.forEach(texture => texture.destroy()); device.destroy();}
}
Object.assign(window, {compositeDenoiseGuides: {capture}});
const result = document.querySelector('#result');
if (result) capture().then(value => {result.textContent = JSON.stringify(value, null, 2);}, error => {result.textContent = String(error.stack ?? error);});
