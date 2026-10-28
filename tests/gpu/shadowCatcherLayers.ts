import {WGPURayTraceOutputPass} from '../../src/renderer/WGPURayTraceOutput.js';
import {WGPUFullQuadPass} from '../../src/renderer/WGPUFullQuadPass.js';
import {composeDefine, composeMain} from '../../src/renderer/wgsl/compose.frag.wgsl.js';

/** Check the three disjoint primary-sample classes against their analytic sum. */
export async function checkShadowCatcherLayers(device: GPUDevice) {
  const size = 16, samples = 32, resources: (GPUBuffer | GPUTexture)[] = [];
  const buffer = (values: number[]) => {
    const data = new Float32Array(size * size * values.length);
    for (let i = 0; i < data.length; i += values.length) data.set(values, i);
    const result = device.createBuffer({size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(result, 0, data); resources.push(result); return result;
  };
  const zero = device.createTexture({size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING});
  resources.push(zero);
  const bloom = device.createTexture({size: [size, size], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  const bloomRGB = [.2, .3, .4];
  const bloomData = new Float32Array(size * size * 4);
  for (let i = 0; i < bloomData.length; i += 4) bloomData.set([...bloomRGB, 0], i);
  device.queue.writeTexture({texture: bloom}, bloomData, {bytesPerRow: size * 16}, [size, size]);
  resources.push(bloom);
  const layers = new WGPURayTraceOutputPass(device, zero);
  layers.setSize(size, size); layers.setSampleCount(samples); layers.setSampleTileGrid(1, 1);
  const compose = new WGPUFullQuadPass('Shadow catcher sample classes', device, {
    fsDefine: composeDefine, fsMain: composeMain, textureWillBeRead: true,
    inputs: ['colorTex', 'foregroundTex', 'catcherBackgroundTex', 'flatBackgroundMaskTex', 'shadowCatcherTex', 'bloomTex'],
    outputs: ['color'], uniforms: [
      {label: 'exposure', type: 'f32', data: 1},
      {label: 'toneMappingParams', type: 'vec2f', data: [4, 0]},
      {label: 'hdrOutputEnabled', type: 'f32', data: 0},
      {label: 'colorGradingParams', type: 'vec4f', data: [1, 1, 0, 0]},
      {label: 'flatBackgroundColor', type: 'vec4f', data: [0, 0, 0, 1]},
      {label: 'shadowCatcherColor', type: 'vec3f', data: [0, 0, 0]},
      {label: 'shadowCatcherAlpha', type: 'f32', data: 1},
      {label: 'shadowCatcherEnabled', type: 'f32', data: 1},
      {label: 'bloomIntensity', type: 'f32', data: 0}
    ]
  });
  compose.setSize(size, size); compose.setOutputParams({color: {format: 'rgba32float'}});
  const srgb = (v: number) => v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055;
  const geometry = [.4, .2, .1], backdrop = [.18, .4, .7], shadowColor = [.1, .05, .02];
  const results = [];
  try {
    for (const entry of [
      {name: 'miss without receiver coverage', f: 0, c: 0, shadow: 0},
      {name: 'geometry/miss without receiver coverage', f: .5, c: 0, shadow: 0},
      {name: 'receiver/miss', f: 0, c: .5, shadow: 0},
      {name: 'thin receiver/miss', f: 0, c: 1 / 32, shadow: 0},
      {name: 'mostly receiver/miss', f: 0, c: 31 / 32, shadow: 0},
      {name: 'shadow only on receiver', f: 0, c: .5, shadow: .75},
      {name: 'geometry/receiver/miss', f: .25, c: .25, shadow: .75},
      {name: 'thin geometry/receiver/miss', f: 1 / 32, c: 1 / 32, shadow: .5},
      {name: 'geometry/receiver', f: .5, c: .5, shadow: .75},
      {name: 'translucent geometry/receiver/miss', f: .25, c: .25, shadow: .75, alpha: .5},
      {name: 'exposure', f: .25, c: .25, shadow: .75, exposure: .5},
      {name: 'bloom', f: .25, c: .25, shadow: .75, bloom: .25},
      {name: 'HDR', f: .25, c: .25, shadow: .75, hdr: true}
    ]) {
      const {f, c, shadow} = entry, m = 1 - f - c, alpha = entry.alpha ?? 1, exposure = entry.exposure ?? 1;
      const backgroundCoverage = c + m;
      const rgb = geometry.map((v, ch) => samples * (f * v + backgroundCoverage * backdrop[ch]));
      const encoder = device.createCommandEncoder();
      // Raw accumulation: geometry contributes to hit count, misses do not;
      // separated background owns both receiver and flat-miss radiance/alpha.
      layers.createPass(encoder, {
        color: buffer([...rgb, samples * (f * alpha + backgroundCoverage)]),
        normal: buffer([0, samples * (f + c), 0, samples]),
        albedo: buffer([samples * (f + c), samples * (f + c), samples * (f + c), samples * (f + c)]),
        // Moments z/w: occluded and total light samples, four per catcher hit.
        shadowCatcher: buffer([
          c * samples, backgroundCoverage * samples, c * samples, 0,
          ...backdrop.map(v => v * backgroundCoverage * samples), backgroundCoverage * samples,
          0, 0, 4 * c * shadow * samples, 4 * c * samples
        ])
      }, true);
      compose.setUniform('flatBackgroundColor', [...backdrop, 1]);
      compose.setUniform('shadowCatcherColor', shadowColor);
      compose.setUniform('exposure', exposure); compose.setUniform('hdrOutputEnabled', +(entry.hdr ?? false));
      compose.setUniform('bloomIntensity', entry.bloom ?? 0);
      compose.createPass(encoder, {
        colorTex: layers.getOutput('color'), foregroundTex: layers.getOutput('foreground'),
        catcherBackgroundTex: layers.getOutput('catcherBackground'), flatBackgroundMaskTex: layers.getOutput('albedo'),
        shadowCatcherTex: layers.getOutput('shadowCatcher'), bloomTex: bloom
      });
      const readback = device.createBuffer({size: size * 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      encoder.copyTextureToBuffer({texture: compose.getOutput('color')}, {buffer: readback, bytesPerRow: 256}, [size, size]);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Float32Array(readback.getMappedRange());
      const visibleBackground = m + c * (1 - shadow), shadowAlpha = c * shadow;
      const expectedAlpha = f * alpha + visibleBackground + shadowAlpha;
      const expected = geometry.map((v, ch) => {
        const encode = (value: number) => entry.hdr ? srgb(value * exposure) : Math.min(1, value * exposure) ** (1 / 2.2);
        const spill = bloomRGB[ch] * (entry.bloom ?? 0);
        const encoded = encode(v + spill);
        const backdropDisplay = srgb(backdrop[ch]) + Math.max(encode(backdrop[ch] + spill) - encode(backdrop[ch]), 0);
        return (encoded * f * alpha + backdropDisplay * visibleBackground + shadowColor[ch] * shadowAlpha) / expectedAlpha;
      });
      expected.push(expectedAlpha);
      let maxError = 0;
      for (let i = 0; i < pixels.length; i++) {
        if (!Number.isFinite(pixels[i])) throw new Error(`${entry.name}: non-finite output`);
        maxError = Math.max(maxError, Math.abs(pixels[i] - expected[i % 4]));
      }
      readback.unmap(); readback.destroy();
      if (maxError > .001) throw new Error(`${entry.name}: layer sum error ${maxError}`);
      results.push({name: entry.name, maxError});
    }
    return results;
  } finally {compose.dispose(); layers.dispose(); resources.forEach(resource => resource.destroy());}
}
