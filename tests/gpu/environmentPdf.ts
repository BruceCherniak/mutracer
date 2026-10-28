import wgsl from '../../src/renderer/wgsl/chunks/envMap.wgsl.js';
import glsl from '../../src/renderer/glsl/chunks/envMap.glsl.js';
import { envMapDistribution } from '../../src/renderer/envMapDistribution.js';

// Exact poles, their nearest useful f32 neighbours, and both sides of the seam.
const cases = new Float32Array([
  .5, 0, 0, .5, .5, 1, 1 - 2 ** -24, .5,
  .5, 2 ** -24, 2 ** -24, .5, .5, 1 - 2 ** -24, 1 - 2 ** -24, .5,
  0, .5, .5, 0, 1, .5, .5, 1 - 2 ** -24, .5, .5, .5, .5
]);
const count = cases.length / 4;
const constants = 'const float PI=3.141592653589793; const float TWOPI=6.283185307179586; const float INVPI=0.3183098861837907; const float INVPI2=0.10132118364233778;';

async function webgpu(distribution: Float32Array, width: number, height: number) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU is required');
  const device = await adapter.requestDevice();
  const texture = (w: number, h: number) => device.createTexture({size: [w, h], format: 'rg32float', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING});
  const map = texture(width - 2, height - 1), cdf = texture(width, height);
  device.queue.writeTexture({texture: cdf}, distribution, {bytesPerRow: width * 8}, [width, height]);
  const input = device.createBuffer({size: cases.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(input, 0, cases);
  const output = device.createBuffer({size: cases.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const readback = device.createBuffer({size: cases.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
  try {
    const module = device.createShaderModule({code: `
const PI=3.141592653589793; const TWOPI=6.283185307179586; const INVPI=0.3183098861837907; const INVPI2=0.10132118364233778;
struct Rotation { environmentRotation: mat3x3f }
const rtUniform=Rotation(mat3x3f(vec3f(1,0,0),vec3f(0,1,0),vec3f(0,0,1)));
@group(0) @binding(0) var envMap:texture_2d<f32>;
@group(0) @binding(1) var envMapDistribution:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> cases:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> result:array<vec4f>;
${wgsl}
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u) {
  let c=cases[id.x]; var uv:vec2f; var pdf:f32;
  let direction=sampleEnvmap(c.zw,&uv,&pdf);
  result[id.x]=vec4f(envMapPdf(c.xy),pdf,envMapPdf(uv),length(direction));
}`});
    const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
      {binding: 0, resource: map.createView()}, {binding: 1, resource: cdf.createView()},
      {binding: 2, resource: {buffer: input}}, {binding: 3, resource: {buffer: output}}
    ]});
    const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count); pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, cases.byteLength); device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return new Float32Array(readback.getMappedRange().slice(0));
  } finally { device.destroy(); }
}

function webgl(distribution: Float32Array, width: number, height: number) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL 2 float outputs are required');
  const shader = (type: number, source: string) => {
    const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0,1);}`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
${constants}
uniform sampler2D envMap,envMapDistribution,backgroundMap,inputCases;
uniform mat3 environmentRotation,backgroundMapRotation;
uniform vec4 backgroundMapTransform,groundedBackgroundParams; uniform vec2 groundedBackgroundCenter;
vec4 textureLinear(sampler2D image,vec2 uv){return vec4(0);}
${glsl.main}
out vec4 result;
void main(){vec4 c=texelFetch(inputCases,ivec2(int(gl_FragCoord.x),0),0);vec2 uv;float pdf;
vec3 direction=sampleEnvmap(c.zw,uv,pdf);result=vec4(envMapPdf(c.xy),pdf,envMapPdf(uv),length(direction));}`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)!);
  const texture = (unit: number, name: string, w: number, h: number, data: Float32Array | null, format: number = gl.RG32F, channels: number = gl.RG) => {
    const texture = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, format, w, h, 0, channels, gl.FLOAT, data);
    gl.uniform1i(gl.getUniformLocation(program, name), unit); return texture;
  };
  try {
    gl.useProgram(program);
    texture(0, 'envMap', width - 2, height - 1, null); texture(1, 'envMapDistribution', width, height, distribution);
    texture(2, 'inputCases', count, 1, cases, gl.RGBA32F, gl.RGBA);
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'environmentRotation'), false, [1,0,0,0,1,0,0,0,1]);
    const target = texture(3, 'unused', count, 1, null, gl.RGBA32F, gl.RGBA), framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete float framebuffer');
    gl.viewport(0, 0, count, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const result = new Float32Array(cases.length); gl.readPixels(0, 0, count, 1, gl.RGBA, gl.FLOAT, result);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL PDF check failed');
    return result;
  } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
}

export async function runEnvironmentPdfChecks(backend: 'webgpu' | 'webgl') {
  const results = [];
  for (const [width, height] of [[1, 1], [4, 8]]) {
    const distribution = envMapDistribution({width, height, data: new Float32Array(width * height * 3).fill(1)});
    const data = distribution.data as Float32Array;
    const actual = backend === 'webgpu' ? await webgpu(data, distribution.width, distribution.height) : webgl(data, distribution.width, distribution.height);
    const rowWeights = Array.from({length: height}, (_, y) => Math.sin(Math.PI * (y + .5) / height));
    const equatorPdf = rowWeights[Math.floor(height / 2)] * height / rowWeights.reduce((a, b) => a + b) / (2 * Math.PI * Math.PI);
    for (let i = 0; i < count; i++) {
      const [evaluated, sampled, reevaluated, length] = actual.slice(i * 4, i * 4 + 4);
      if (![evaluated, sampled, reevaluated].every(v => Number.isFinite(v) && v >= 0)) throw new Error(`Invalid PDF in case ${i}: ${actual.slice(i * 4, i * 4 + 4)}`);
      if (Math.abs(sampled - reevaluated) > Math.max(1, sampled) * 1e-4 || Math.abs(length - 1) > 1e-5) throw new Error(`Sampling/evaluation mismatch in case ${i}`);
      if (i < 2 && evaluated !== 0) throw new Error(`Nonzero pole PDF in case ${i}`);
      if (i >= 4 && Math.abs(evaluated - equatorPdf) > 1e-6) throw new Error(`Incorrect equator/seam PDF in case ${i}`);
    }
    results.push({width, height, cases: count, values: Array.from(actual)});
  }
  return {passed: true, backend, results};
}

if (document.querySelector('#summary')) {
  const backend = location.search.includes('webgl') ? 'webgl' : 'webgpu';
  runEnvironmentPdfChecks(backend).then(result => {
    document.querySelector('#summary')!.textContent = JSON.stringify(result);
  }).catch(error => { document.querySelector('#summary')!.textContent = String(error.stack ?? error); });
}
