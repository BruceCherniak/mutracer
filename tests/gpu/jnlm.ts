// Browser-only behavioral tests of the actual compute/fragment passes.
// Run with npm run dev, then open /tests/gpu/jnlm.html on a real GPU.
import { WGPUJNLMDenoisePass } from '../../src/renderer/WGPUJNLMDenoiser.js';
import { WebGLJNLMDenoisePass } from '../../src/renderer/WebGLJNLMDenoiser.js';
import { createJNLMDenoiser, type JNLMOptions } from '../../src/renderer/jnlm.js';
import { FrameBuffer, Renderer, Texture2D, constants } from '../../src/renderer/webgl.js';

const width = 64;
const height = 48;
const samples = 32;
const pixels = width * height;
const result = document.querySelector('#result')!;
const lines: string[] = [];
const report = (line: string) => { lines.push(line); result.textContent = lines.join('\n'); };

interface Fixture {
  color: Float32Array;
  albedo: Float32Array;
  normal: Float32Array;
  moments: Float32Array;
  target: Float32Array;
  low: number[];
  high: number[];
}

function fixture(kind: 'flat' | 'albedo' | 'normal' | 'coverage' | 'low-contrast' | 'unrelated', albedoScale = 0.5): Fixture {
  const color = new Float32Array(pixels * 4);
  const albedo = new Float32Array(pixels * 4);
  const normal = new Float32Array(pixels * 4);
  const moments = new Float32Array(pixels * 4);
  const target = new Float32Array(pixels);
  const low: number[] = [], high: number[] = [];
  let state = 1;
  for (let p = 0; p < pixels; p++) {
    const x = p % width, y = Math.floor(p / width);
    const sign = (Math.floor(x / 2) & 1) ? 1 : -1;
    const subtle = kind === 'low-contrast' || kind === 'unrelated';
    const textureFactor = subtle ? 1 + sign * 0.05 : 1 + sign * 0.3;
    const value = kind === 'low-contrast' ? 0.2 * textureFactor : kind === 'albedo' || kind === 'normal' ? 0.2 + sign * 0.06 : 0.2;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = (state / 2 ** 32 - 0.5) * 0.08;
    const alpha = kind === 'coverage' ? (x < width / 2 ? 0.2 : 0.8) : 1;
    const f = p * 4;
    color.set([value + noise, value + noise, value + noise, alpha], f);
    const a = albedoScale * (kind === 'albedo' || subtle ? textureFactor : 1);
    albedo.set([a, a, a, alpha], f);
    normal.set([kind === 'normal' ? 0.5 + sign * 0.06 : 0.5, 0.5, 1, 1], f);
    // The luminance guide has the same noisy mean as the color. Its variance
    // deliberately permits color mixing, so features must preserve the detail.
    const mean = value + noise;
    moments.set([mean * samples, mean * mean * samples + 0.005 * samples * (samples - 1), samples, 0], f);
    target[p] = value;
    if (x >= 8 && x < width - 8 && y >= 8 && y < height - 8) (sign < 0 ? low : high).push(p);
  }
  return { color, albedo, normal, moments, target, low, high };
}

async function webgpu(device: GPUDevice, input: Fixture, options: JNLMOptions = {}) {
  const denoiser = createJNLMDenoiser(options);
  const resources: (GPUBuffer | GPUTexture)[] = [];
  const buffer = (data: Float32Array) => {
    const b = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data); resources.push(b); return b;
  };
  const texture = (data: Float32Array) => {
    const t = device.createTexture({ size: [width, height], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data, { bytesPerRow: width * 16 }, [width, height]);
    resources.push(t); return t;
  };
  const accumulation = new Float32Array(pixels * 12);
  const normals = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    const ray = (height - 1 - Math.floor(p / width)) * width + p % width;
    accumulation.set(input.moments.subarray(p * 4, p * 4 + 2), ray * 12 + 8);
    normals[ray * 4 + 3] = samples;
  }
  const pass = new WGPUJNLMDenoisePass(device);
  const encoder = device.createCommandEncoder();
  const output = pass.encode(encoder, {
    width, height, strength: denoiser.strength, shape: denoiser.shape,
    accumulation: buffer(accumulation), normalAccumulation: buffer(normals),
    color: texture(input.color), albedo: texture(input.albedo), normal: texture(input.normal),
    shadowCatcher: texture(new Float32Array(pixels * 4))
  });
  const read = device.createBuffer({ size: pixels * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  encoder.copyBufferToBuffer(output, 0, read, 0, read.size);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const data = new Float32Array(read.getMappedRange()).slice();
  read.unmap(); read.destroy(); pass.dispose(); resources.forEach(r => r.destroy());
  return data;
}

function webgl(input: Fixture, options: JNLMOptions = {}) {
  const denoiser = createJNLMDenoiser(options);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const renderer = new Renderer({ canvas });
  const resources: Texture2D[] = [];
  const texture = (data: Float32Array) => {
    const t = new Texture2D({ source: { data, width, height }, type: constants.FLOAT, minFilter: constants.NEAREST, magFilter: constants.NEAREST });
    resources.push(t); return t;
  };
  const color = input.color.slice();
  for (let i = 0; i < color.length; i++) if (i % 4 !== 3) color[i] = color[i] ** (1 / 2.2);
  const pass = new WebGLJNLMDenoisePass(renderer);
  const output = pass.render({
    width, height, strength: denoiser.strength, shape: denoiser.shape,
    moments: texture(input.moments), color: texture(color), albedo: texture(input.albedo),
    normal: texture(input.normal), shadowCatcher: texture(new Float32Array(pixels * 4))
  });
  const framebuffer = new FrameBuffer(); framebuffer.bind(renderer, [output]);
  const data = new Float32Array(pixels * 4);
  renderer.gl.readPixels(0, 0, width, height, renderer.gl.RGBA, renderer.gl.FLOAT, data);
  if (renderer.gl.getError()) throw new Error('WebGL readback failed');
  for (let i = 0; i < data.length; i++) if (i % 4 !== 3) data[i] = data[i] ** 2.2;
  framebuffer.dispose(renderer); pass.dispose(); resources.forEach(t => t.dispose(renderer.gl)); renderer.dispose();
  return data;
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function measure(input: Fixture, output: Float32Array) {
  let rawMSE = 0, mse = 0;
  const interior = [...input.low, ...input.high];
  for (const p of interior) {
    rawMSE += (input.color[p * 4] - input.target[p]) ** 2;
    mse += (output[p * 4] - input.target[p]) ** 2;
  }
  const mean = (indices: number[]) => indices.reduce((sum, p) => sum + output[p * 4], 0) / indices.length;
  return { noiseRatio: mse / rawMSE, contrast: mean(input.high) - mean(input.low) };
}

try {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('A real WebGPU adapter is required');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', event => errors.push((event as GPUUncapturedErrorEvent).error.message));
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  report(`WebGPU: ${info?.vendor ?? 'available'}; WebGL 2: native context`);
  for (const [backend, run] of [
    ['WebGPU', (input: Fixture, options?: JNLMOptions) => webgpu(device, input, options)],
    ['WebGL 2', (input: Fixture, options?: JNLMOptions) => Promise.resolve(webgl(input, options))]
  ] as const) {
    const flat = fixture('flat');
    const flatOutput = await run(flat);
    check(flatOutput.every(Number.isFinite), `${backend}: non-finite output`);
    const flatStats = measure(flat, flatOutput);
    check(flatStats.noiseRatio < 0.15, `${backend}: flat-region noise remains (${flatStats.noiseRatio})`);
    report(`${backend}: flat-region MSE ratio ${flatStats.noiseRatio.toFixed(4)}`);
    for (const options of [
      { searchRadius: 1, patchRadius: 0, iterations: 1, strength: 0.5 },
      { searchRadius: 7, patchRadius: 3, iterations: 4, albedoBandwidth: 0.2, normalBandwidth: 0.1 }
    ]) {
      const configured = await run(flat, options);
      check(configured.every(Number.isFinite), `${backend}: non-finite configured output`);
      check(measure(flat, configured).noiseRatio < 0.5, `${backend}: configured filter fails to reduce noise`);
    }
    report(`${backend}: custom radii, strength and 1–4 passes reduce noise`);
    for (const scale of [0, 0.005]) {
      const black = fixture('flat', scale), output = await run(black);
      check(output.every(Number.isFinite), `${backend}: non-finite near-black regression`);
      check(measure(black, output).noiseRatio < 0.15, `${backend}: near-black guide amplifies noise`);
    }
    report(`${backend}: black and near-black guides remain finite and smooth`);
    const textureStats = [];
    for (const scale of [0.5, 0.03]) {
      const input = fixture('albedo', scale), output = await run(input);
      const stats = measure(input, output); textureStats.push(stats);
      check(stats.contrast > 0.1, `${backend}: erased ${scale === 0.5 ? 'bright' : 'dark'} texture (${stats.contrast})`);
      check(stats.noiseRatio < 0.3, `${backend}: texture noise remains (${stats.noiseRatio})`);
      report(`${backend}: albedo ${scale}, contrast ${stats.contrast.toFixed(4)}, MSE ratio ${stats.noiseRatio.toFixed(4)}`);
    }
    check(Math.abs(textureStats[0].contrast - textureStats[1].contrast) < 0.001, `${backend}: albedo protection depends on brightness`);
    for (const scale of [0.5, 0.03]) {
      const subtle = fixture('low-contrast', scale);
      const stats = measure(subtle, await run(subtle));
      check(stats.contrast > 0.016, `${backend}: erased low-contrast texture (${stats.contrast})`);
      check(stats.noiseRatio < 0.3, `${backend}: noisy low-contrast texture (${stats.noiseRatio})`);
      report(`${backend}: subtle albedo ${scale}, contrast ${stats.contrast.toFixed(4)}, MSE ratio ${stats.noiseRatio.toFixed(4)}`);
    }
    const unrelated = fixture('unrelated');
    const unrelatedStats = measure(unrelated, await run(unrelated));
    check(Math.abs(unrelatedStats.contrast) < 0.003, `${backend}: imprinted unrelated albedo (${unrelatedStats.contrast})`);
    check(unrelatedStats.noiseRatio < 0.15, `${backend}: unrelated guide amplifies noise (${unrelatedStats.noiseRatio})`);
    report(`${backend}: unrelated albedo contrast ${unrelatedStats.contrast.toFixed(4)}`);
    const normal = fixture('normal');
    const normalStats = measure(normal, await run(normal));
    check(normalStats.contrast > 0.1, `${backend}: erased normal detail (${normalStats.contrast})`);
    report(`${backend}: normal detail contrast ${normalStats.contrast.toFixed(4)}`);
    const broadNormalStats = measure(normal, await run(normal, { normalBandwidth: 0.5 }));
    check(broadNormalStats.contrast < normalStats.contrast * 0.5, `${backend}: normal tolerance has no effect`);
    const coverage = fixture('coverage', 0.03), coverageOutput = await run(coverage);
    let maximumAlphaError = 0;
    for (let p = 0; p < pixels; p++) maximumAlphaError = Math.max(maximumAlphaError, Math.abs(coverageOutput[p * 4 + 3] - coverage.color[p * 4 + 3]));
    check(maximumAlphaError < 0.002, `${backend}: blurred coverage edge (${maximumAlphaError})`);
    report(`${backend}: coverage edge preserved (${maximumAlphaError.toFixed(6)})`);
  }
  await device.queue.onSubmittedWorkDone();
  check(errors.length === 0, errors.join('\n'));
  device.destroy(); report('PASS');
} catch (error) { report(`FAIL: ${error}`); console.error(error); }
