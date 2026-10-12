import { getTargetShaderCache } from './WGPUShaderCache.js';
import shadowCatcherAccumulationWGSL from './wgsl/chunks/shadowCatcherAccumulation.wgsl.js';

import {
  JNLM_DEFAULT_COLOR_SENSITIVITY,
  JNLM_DEFAULT_SHAPE,
  JNLM_ALBEDO_FLOOR,
  JNLM_ALBEDO_REGULARIZATION,
  JNLM_COVERAGE_BANDWIDTH,
  JNLM_MAX_ITERATIONS,
  jnlmPassDilation,
  type JNLMFilterShape
} from './jnlm.js';

/** WebGPU passes of the JNLM denoiser described in `jnlm.ts`. */

export const JNLM_WORKGROUP_SIZE = 8;

const paramsWGSL = /* wgsl */ `
struct JNLMParams {
  size: vec2u,
  colorSensitivity: f32,
  // Pixel spacing of the search window and patches in this pass.
  dilation: f32,
}
@group(0) @binding(0) var<uniform> params: JNLMParams;
`;

/**
 * Pass 1: the guide mean and the variance of that mean from the accumulated
 * moments. Ray buffers are stored bottom-up; guides use texture rows.
 */
export const jnlmGuideWGSL = /* wgsl */ `
${paramsWGSL}
${shadowCatcherAccumulationWGSL}
@group(0) @binding(1) var<storage, read> accumulation: array<ShadowCatcherAccumulation>;
@group(0) @binding(2) var<storage, read> normalBuffer: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> rawGuide: array<vec2f>;

@compute @workgroup_size(${JNLM_WORKGROUP_SIZE}, ${JNLM_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.size;
  if (id.x >= size.x || id.y >= size.y) { return; }
  let rayIndex = id.x + (size.y - 1u - id.y) * size.x;
  let n = normalBuffer[rayIndex].a;
  let moments = accumulation[rayIndex].moments;
  let mean = moments.x / max(n, 1.0);
  // Variance of the mean, or -1 when one sample cannot estimate it.
  var variance = -1.0;
  if (n >= 2.0) {
    variance = max(moments.y - n * mean * mean, 0.0) / (n * (n - 1.0));
  }
  rawGuide[id.x + id.y * size.x] = vec2f(mean, variance);
}
`;

/**
 * Pass 2: smooth the noisy per-pixel variance over 3 x 3 pixels. Pixels with
 * a single sample take the spatial variance of their neighborhood instead.
 */
export const jnlmVarianceWGSL = /* wgsl */ `
${paramsWGSL}
@group(0) @binding(1) var<storage, read> rawGuide: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> guide: array<vec2f>;

@compute @workgroup_size(${JNLM_WORKGROUP_SIZE}, ${JNLM_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = params.size;
  if (id.x >= size.x || id.y >= size.y) { return; }
  let center = rawGuide[id.x + id.y * size.x];
  var varianceSum = 0.0;
  var varianceCount = 0.0;
  var meanSum = 0.0;
  var meanSquareSum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = clamp(vec2i(id.xy) + vec2i(dx, dy), vec2i(0), vec2i(size) - 1);
      let value = rawGuide[u32(q.x) + u32(q.y) * size.x];
      meanSum += value.x;
      meanSquareSum += value.x * value.x;
      if (value.y >= 0.0) {
        varianceSum += value.y;
        varianceCount += 1.0;
      }
    }
  }
  var variance: f32;
  if (center.y >= 0.0) {
    variance = varianceSum / varianceCount;
  } else {
    let spatialMean = meanSum / 9.0;
    variance = max(meanSquareSum / 9.0 - spatialMean * spatialMean, 0.0) * 9.0 / 8.0;
  }
  guide[id.x + id.y * size.x] = vec2f(center.x, variance);
}
`;

/** Copies the composed image into the filter's color buffer. */
export const jnlmLoadColorWGSL = /* wgsl */ `
${paramsWGSL}
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outColor: array<vec4f>;

@compute @workgroup_size(${JNLM_WORKGROUP_SIZE}, ${JNLM_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.size.x || id.y >= params.size.y) { return; }
  outColor[id.x + id.y * params.size.x] = textureLoad(colorTex, vec2i(id.xy), 0);
}
`;

/**
 * Pass 3: the joint NL-means filter of the composed image. It also filters
 * the guide with the same weights, with the variance of the weighted mean,
 * for a following pass. The albedo regression corrects color only, keeping
 * uncertain fitted texture responses out of the matching guide.
 */
export function createJNLMFilterWGSL({
  searchRadius, patchRadius, albedoBandwidth, normalBandwidth
}: JNLMFilterShape = JNLM_DEFAULT_SHAPE) {
  const patchSize = (2 * patchRadius + 1) ** 2;
  return /* wgsl */ `
${paramsWGSL}
@group(0) @binding(1) var<storage, read> guide: array<vec2f>;
@group(0) @binding(2) var<storage, read> color: array<vec4f>;
@group(0) @binding(3) var albedoTex: texture_2d<f32>;
@group(0) @binding(4) var normalTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> outColor: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> outGuide: array<vec2f>;
@group(0) @binding(7) var shadowCatcherTex: texture_2d<f32>;

const SEARCH_RADIUS = ${searchRadius};
const PATCH_RADIUS = ${patchRadius};
const PATCH_SIZE = ${patchSize};
// Variance cancellation strength alpha of the paper.
const VARIANCE_CANCELLATION = 1.0;
// Inverse squared feature bandwidths. Normals are encoded as n * 0.5 + 0.5.
const INV_ALBEDO_BANDWIDTH2 = ${(1 / albedoBandwidth ** 2).toFixed(6)};
const INV_COVERAGE_BANDWIDTH2 = ${(1 / JNLM_COVERAGE_BANDWIDTH ** 2).toFixed(6)};
const INV_NORMAL_BANDWIDTH2 = ${(1 / normalBandwidth ** 2).toFixed(6)};
// Lower bound of the center weight, so a pixel unlike all of its neighbors
// (a thin highlight) is kept rather than replaced by them.
const CENTER_WEIGHT_MIN = 0.01;

fn pixelIndex(p: vec2i) -> u32 {
  let q = clamp(p, vec2i(0), vec2i(params.size) - 1);
  return u32(q.x) + u32(q.y) * params.size.x;
}

fn featureDistance(q: vec2i, centerAlbedo: vec4f, centerNormal: vec3f) -> f32 {
  let albedo = textureLoad(albedoTex, q, 0);
  // Absolute differences in linear albedo erase low-contrast dark textures.
  // Measure RGB contrast relative to both pixels; keep coverage absolute.
  let albedoScale = max((albedo.rgb + centerAlbedo.rgb) * 0.5, vec3f(${JNLM_ALBEDO_FLOOR}));
  let albedoDelta = (albedo.rgb - centerAlbedo.rgb) / albedoScale;
  let coverageDelta = albedo.a - centerAlbedo.a;
  let normalDelta = textureLoad(normalTex, q, 0).rgb - centerNormal;
  return max(
    dot(albedoDelta, albedoDelta) * INV_ALBEDO_BANDWIDTH2
      + coverageDelta * coverageDelta * INV_COVERAGE_BANDWIDTH2,
    dot(normalDelta, normalDelta) * INV_NORMAL_BANDWIDTH2
  );
}

fn premultiplied(c: vec4f) -> vec4f {
  return vec4f(c.rgb * c.a, c.a);
}

@compute @workgroup_size(${JNLM_WORKGROUP_SIZE}, ${JNLM_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(params.size);
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let step = i32(params.dilation);
  let centerAlbedo = textureLoad(albedoTex, p, 0);
  let centerNormalTexel = textureLoad(normalTex, p, 0);
  let centerNormal = centerNormalTexel.rgb;
  let index = pixelIndex(p);
  // Primary misses show the background directly. It has no features that
  // protect its detail and no noise beyond antialiasing, so keep it.
  if (centerNormalTexel.a <= 0.0 && textureLoad(shadowCatcherTex, p, 0).r <= 0.0) {
    outColor[index] = color[index];
    outGuide[index] = guide[index];
    return;
  }

  var centerPatch: array<vec2f, PATCH_SIZE>;
  var k = 0;
  for (var dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (var dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      centerPatch[k] = guide[pixelIndex(p + vec2i(dx, dy) * step)];
      k++;
    }
  }
  let k2 = params.colorSensitivity * params.colorSensitivity;

  var sum = vec4f(0.0);
  let featureScale = max(centerAlbedo.rgb, vec3f(${JNLM_ALBEDO_FLOOR}));
  var featureSum = vec3f(0.0);
  var featureSquareSum = vec3f(0.0);
  var featureColorSum = vec3f(0.0);
  var guideSum = 0.0;
  var guideVarianceSum = 0.0;
  var weightSum = 0.0;
  var maxWeight = 0.0;
  for (var sy = -SEARCH_RADIUS; sy <= SEARCH_RADIUS; sy++) {
    for (var sx = -SEARCH_RADIUS; sx <= SEARCH_RADIUS; sx++) {
      let q = p + vec2i(sx, sy) * step;
      if (
        (sx == 0 && sy == 0) ||
        q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y
      ) { continue; }

      let features = featureDistance(q, centerAlbedo, centerNormal);
      if (features > 16.0) { continue; }

      var colorDistance = 0.0;
      k = 0;
      for (var dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
        for (var dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
          let a = centerPatch[k];
          let b = guide[pixelIndex(q + vec2i(dx, dy) * step)];
          let delta = a.x - b.x;
          colorDistance += (delta * delta
              - VARIANCE_CANCELLATION * (a.y + min(a.y, b.y)))
            / (1e-10 + k2 * (a.y + b.y));
          k++;
        }
      }
      colorDistance /= f32(PATCH_SIZE);

      let weight = exp(-max(max(colorDistance, 0.0), features));
      let index = pixelIndex(q);
      let c = color[index];
      let g = guide[index];
      // Filter premultiplied color so coverage and color stay consistent.
      let a = (textureLoad(albedoTex, q, 0).rgb - centerAlbedo.rgb) / featureScale;
      let value = premultiplied(c);
      sum += value * weight;
      featureSum += a * weight;
      featureSquareSum += a * a * weight;
      featureColorSum += a * value.rgb * weight;
      guideSum += g.x * weight;
      guideVarianceSum += g.y * weight * weight;
      weightSum += weight;
      maxWeight = max(maxWeight, weight);
    }
  }

  // Weight the center like its most similar neighbor (Buades et al. 2005)
  // instead of 1, so isolated outliers are not kept unfiltered.
  let center = color[index];
  let centerGuide = guide[index];
  let centerWeight = max(maxWeight, CENTER_WEIGHT_MIN);
  let totalWeight = weightSum + centerWeight;
  let centerValue = premultiplied(center);
  let mean = (sum + centerValue * centerWeight) / totalWeight;
  // Fit each color channel against relative albedo with the same JNLM weights.
  // Centering at this pixel avoids cancellation when the feature is constant.
  let meanFeature = featureSum / totalWeight;
  let featureVariance = max(featureSquareSum / totalWeight - meanFeature * meanFeature, vec3f(0.0));
  let covariance = featureColorSum / totalWeight - meanFeature * mean.rgb;
  // A 1% contrast ridge stabilizes flat guides. Bound the response between no
  // texture dependence and multiplicative albedo modulation; specular color
  // with an unrelated albedo falls back to the weighted mean.
  let meanAlbedo = centerAlbedo.rgb + meanFeature * featureScale;
  let maximumSlope = mean.rgb * featureScale / max(meanAlbedo, vec3f(${JNLM_ALBEDO_FLOOR}));
  let slope = clamp(covariance / (featureVariance + vec3f(${JNLM_ALBEDO_REGULARIZATION})), vec3f(0.0), maximumSlope);
  let corrected = mean.rgb - slope * meanFeature;
  let filtered = vec4f(max(corrected, vec3f(0.0)), max(mean.a, 0.0));
  let rgb = select(
    center.rgb,
    filtered.rgb / max(filtered.a, 1e-6),
    filtered.a > 1e-6
  );
  outColor[index] = vec4f(rgb, filtered.a);
  outGuide[index] = vec2f(
    (guideSum + centerGuide.x * centerWeight) / totalWeight,
    (guideVarianceSum + centerGuide.y * centerWeight * centerWeight)
      / (totalWeight * totalWeight)
  );
}
`;
}

export interface JNLMInputs {
  width: number;
  height: number;
  /** Normalized shadow-catcher mask; red is the catcher coverage. */
  shadowCatcher: GPUTexture;
  /** Ray-trace auxiliary accumulation holding the guide moments. */
  accumulation: GPUBuffer;
  /** Ray-trace normal accumulation; its alpha is the per-pixel sample count. */
  normalAccumulation: GPUBuffer;
  /** Composed linear image to filter. */
  color: GPUTexture;
  albedo: GPUTexture;
  normal: GPUTexture;
  strength: number;
  shape: JNLMFilterShape;
}

const MAX_ITERATIONS = JNLM_MAX_ITERATIONS;

export class WGPUJNLMDenoisePass {
  private _device: GPUDevice;
  private _paramsBuffers: GPUBuffer[] = [];
  private _guidePipeline: GPUComputePipeline;
  private _variancePipeline: GPUComputePipeline;
  private _loadColorPipeline: GPUComputePipeline;
  private _filterPipeline?: GPUComputePipeline;
  private _filterShapeKey = '';
  private _guides: GPUBuffer[] = [];
  private _colors: GPUBuffer[] = [];
  private _width = 0;
  private _height = 0;

  constructor(device: GPUDevice) {
    this._device = device;
    // One uniform buffer per pass: every pass of an encoder sees the last
    // writeBuffer() of a shared one.
    for (let i = 0; i <= MAX_ITERATIONS; i++) {
      this._paramsBuffers.push(device.createBuffer({
        label: 'JNLM params',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
    }
    this._guidePipeline = this._createPipeline('JNLM guide', jnlmGuideWGSL);
    this._variancePipeline = this._createPipeline('JNLM variance', jnlmVarianceWGSL);
    this._loadColorPipeline = this._createPipeline('JNLM load color', jnlmLoadColorWGSL);
  }

  private _createPipeline(label: string, code: string) {
    return getTargetShaderCache(this._device).createComputePipeline({
      label,
      layout: 'auto',
      compute: {
        module: getTargetShaderCache(this._device).createShaderModule({ label, code }),
        entryPoint: 'main'
      }
    });
  }

  private _getFilterPipeline(shape: JNLMFilterShape) {
    const key = JSON.stringify(shape);
    if (!this._filterPipeline || key !== this._filterShapeKey) {
      this._filterPipeline = this._createPipeline('JNLM filter', createJNLMFilterWGSL(shape));
      this._filterShapeKey = key;
    }
    return this._filterPipeline;
  }

  private _ensureBuffers(width: number, height: number) {
    if (width === this._width && height === this._height && this._colors.length) return;
    this._destroyBuffers();
    const pixels = width * height;
    const createBuffer = (label: string, bytes: number) =>
      this._device.createBuffer({
        label,
        size: pixels * bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
      });
    this._guides = [createBuffer('JNLM guide A', 8), createBuffer('JNLM guide B', 8)];
    this._colors = [createBuffer('JNLM color A', 16), createBuffer('JNLM color B', 16)];
    this._width = width;
    this._height = height;
  }

  private _destroyBuffers() {
    for (const buffer of [...this._guides, ...this._colors]) buffer.destroy();
    this._guides = [];
    this._colors = [];
  }

  /** Encodes the denoiser and returns the RGBA32F output in texture rows. */
  encode(encoder: GPUCommandEncoder, inputs: JNLMInputs): GPUBuffer {
    const { width, height, shape } = inputs;
    this._ensureBuffers(width, height);
    const iterations = Math.min(Math.max(Math.round(shape.iterations), 1), MAX_ITERATIONS);
    const sensitivity = JNLM_DEFAULT_COLOR_SENSITIVITY * Math.max(inputs.strength, 1e-3);
    this._paramsBuffers.forEach((buffer, i) => {
      const params = new ArrayBuffer(16);
      new Uint32Array(params, 0, 2).set([width, height]);
      // Buffer i (from 1) is filter pass i - 1; index 0 is the prepasses.
      new Float32Array(params, 8, 2).set([sensitivity, jnlmPassDilation(Math.max(i - 1, 0))]);
      this._device.queue.writeBuffer(buffer, 0, params);
    });

    const device = this._device;
    const filterPipeline = this._getFilterPipeline(shape);
    const bind = (
      pipeline: GPUComputePipeline,
      paramsBuffer: GPUBuffer,
      resources: GPUBindingResource[]
    ) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          ...resources.map((resource, i) => ({ binding: i + 1, resource }))
        ]
      });
    const [guideA, guideB] = this._guides;
    const [colorA, colorB] = this._colors;
    const prepass = this._paramsBuffers[0];
    const passes: [GPUComputePipeline, GPUBindGroup][] = [
      [this._guidePipeline, bind(this._guidePipeline, prepass, [
        { buffer: inputs.accumulation },
        { buffer: inputs.normalAccumulation },
        { buffer: guideB }
      ])],
      [this._variancePipeline, bind(this._variancePipeline, prepass, [
        { buffer: guideB },
        { buffer: guideA }
      ])],
      [this._loadColorPipeline, bind(this._loadColorPipeline, prepass, [
        inputs.color.createView(),
        { buffer: colorA }
      ])]
    ];
    const albedoView = inputs.albedo.createView();
    const normalView = inputs.normal.createView();
    const shadowCatcherView = inputs.shadowCatcher.createView();
    let guides = [guideA, guideB];
    let colors = [colorA, colorB];
    for (let i = 1; i <= iterations; i++) {
      passes.push([filterPipeline, bind(filterPipeline, this._paramsBuffers[i], [
        { buffer: guides[0] },
        { buffer: colors[0] },
        albedoView,
        normalView,
        { buffer: colors[1] },
        { buffer: guides[1] },
        shadowCatcherView
      ])]);
      guides = [guides[1], guides[0]];
      colors = [colors[1], colors[0]];
    }
    const pass = encoder.beginComputePass({ label: 'JNLM denoise' });
    for (const [pipeline, bindGroup] of passes) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(width / JNLM_WORKGROUP_SIZE),
        Math.ceil(height / JNLM_WORKGROUP_SIZE)
      );
    }
    pass.end();
    return colors[0];
  }

  getMemoryBytes() {
    return [...this._paramsBuffers, ...this._guides, ...this._colors]
      .reduce((sum, buffer) => sum + buffer.size, 0);
  }

  dispose() {
    for (const buffer of this._paramsBuffers) buffer.destroy();
    this._destroyBuffers();
  }
}
