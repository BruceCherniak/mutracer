import shadowCatcherAccumulationWGSL from './chunks/shadowCatcherAccumulation.wgsl.js';
import {linearToSrgbDefine} from './compose.frag.wgsl.js';
import {
  JNLM_DEFAULT_COLOR_SENSITIVITY, JNLM_DEFAULT_SHAPE, JNLM_ALBEDO_FLOOR,
  JNLM_ALBEDO_REGULARIZATION, JNLM_COVERAGE_BANDWIDTH, jnlmPassDilation,
  type JNLMFilterShape
} from '../jnlm.js';

// Web textures and native normalized guide buffers use the same filter body.
export type JNLMGuideBindings = 'textures' | 'buffers';
function guideBinding(guides: JNLMGuideBindings, binding: number, name: string): string {
  return guides === 'textures'
    ? `@group(0) @binding(${binding}) var ${name}: texture_2d<f32>;`
    : `@group(0) @binding(${binding}) var<storage, read> ${name}: array<vec4f>;`;
}
function loadGuide(guides: JNLMGuideBindings, name: string, position: string): string {
  return guides === 'textures' ? `textureLoad(${name}, ${position}, 0)` : `${name}[pixelIndex(${position})]`;
}

// Shared uniform packing also fixes sensitivity and dilation for native callers.
export function packJNLMParameters(width: number, height: number, strength: number, pass: number): ArrayBuffer {
  const bytes = new ArrayBuffer(16);
  new Uint32Array(bytes, 0, 2).set([width, height]);
  new Float32Array(bytes, 8, 2).set([
    JNLM_DEFAULT_COLOR_SENSITIVITY * Math.max(strength, 1e-3), jnlmPassDilation(pass)
  ]);
  return bytes;
}

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
export function createJNLMLoadColorWGSL(guides: JNLMGuideBindings = 'textures'): string {
  return /* wgsl */ `
${paramsWGSL}
@group(0) @binding(1) var colorTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outColor: array<vec4f>;
${guides === 'buffers' ? `${shadowCatcherAccumulationWGSL}
@group(0) @binding(3) var<storage, read> normalAccumulation: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> normal: array<vec4f>;
@group(0) @binding(5) var<storage, read> shadowAccumulation: array<ShadowCatcherAccumulation>;
@group(0) @binding(6) var<storage, read_write> shadow: array<vec4f>;
@group(0) @binding(7) var albedoTex: texture_2d<f32>;
@group(0) @binding(8) var<storage, read_write> albedo: array<vec4f>;` : ''}

@compute @workgroup_size(${JNLM_WORKGROUP_SIZE}, ${JNLM_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.size.x || id.y >= params.size.y) { return; }
  outColor[id.x + id.y * params.size.x] = textureLoad(colorTex, vec2i(id.xy), 0);
${guides === 'buffers' ? `  let index = id.x + id.y * params.size.x;
  let rayIndex = id.x + (params.size.y - 1u - id.y) * params.size.x;
  let n = normalAccumulation[rayIndex];
  let samples = max(n.a, 1.0);
  normal[index] = vec4f(n.rgb / samples * 0.5 + 0.5, select(0.0, 1.0, dot(n.rgb, n.rgb) > 0.1));
  shadow[index] = shadowAccumulation[rayIndex].mask / samples;
  albedo[index] = textureLoad(albedoTex, vec2i(id.xy), 0);` : ''}
}
`;
}
export const jnlmLoadColorWGSL = createJNLMLoadColorWGSL();

/**
 * Pass 3: the joint NL-means filter of the composed image. It also filters
 * the guide with the same weights, with the variance of the weighted mean,
 * for a following pass. The albedo regression corrects color only, keeping
 * uncertain fitted texture responses out of the matching guide.
 */
export function createJNLMFilterWGSL({
  searchRadius, patchRadius, albedoBandwidth, normalBandwidth
}: JNLMFilterShape = JNLM_DEFAULT_SHAPE, guides: JNLMGuideBindings = 'textures') {
  const patchSize = (2 * patchRadius + 1) ** 2;
  return /* wgsl */ `
${paramsWGSL}
@group(0) @binding(1) var<storage, read> guide: array<vec2f>;
@group(0) @binding(2) var<storage, read> color: array<vec4f>;
${guideBinding(guides, 3, 'albedoTex')}
${guideBinding(guides, 4, 'normalTex')}
@group(0) @binding(5) var<storage, read_write> outColor: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> outGuide: array<vec2f>;
${guideBinding(guides, 7, 'shadowCatcherTex')}

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
  let albedo = ${loadGuide(guides, 'albedoTex', 'q')};
  // Absolute differences in linear albedo erase low-contrast dark textures.
  // Measure RGB contrast relative to both pixels; keep coverage absolute.
  let albedoScale = max((albedo.rgb + centerAlbedo.rgb) * 0.5, vec3f(${JNLM_ALBEDO_FLOOR}));
  let albedoDelta = (albedo.rgb - centerAlbedo.rgb) / albedoScale;
  let coverageDelta = albedo.a - centerAlbedo.a;
  let normalDelta = ${loadGuide(guides, 'normalTex', 'q')}.rgb - centerNormal;
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
  let centerAlbedo = ${loadGuide(guides, 'albedoTex', 'p')};
  let centerNormalTexel = ${loadGuide(guides, 'normalTex', 'p')};
  let centerNormal = centerNormalTexel.rgb;
  let index = pixelIndex(p);
  // Primary misses show the background directly. It has no features that
  // protect its detail and no noise beyond antialiasing, so keep it.
  if (centerNormalTexel.a <= 0.0 && ${loadGuide(guides, 'shadowCatcherTex', 'p')}.r <= 0.0) {
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
      let a = (${loadGuide(guides, 'albedoTex', 'q')}.rgb - centerAlbedo.rgb) / featureScale;
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

// Compute presentation for hosts that consume the filtered buffer directly.
// Use the same sRGB transfer as browser display composition.
export const jnlmEncodeWGSL = /* wgsl */ `
struct OutputParams { size: vec2u, premultiply: u32, reserved: u32 }
@group(0) @binding(0) var<uniform> params: OutputParams;
@group(0) @binding(1) var<storage, read> color: array<vec4f>;
@group(0) @binding(2) var output: texture_storage_2d<rgba8unorm, write>;
${linearToSrgbDefine}
@compute @workgroup_size(${JNLM_WORKGROUP_SIZE}, ${JNLM_WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= params.size)) { return; }
  let c = color[id.y * params.size.x + id.x];
  var rgb = linearToSrgb(c.rgb);
  if (params.premultiply != 0u) { rgb *= c.a; }
  textureStore(output, id.xy, vec4f(rgb, c.a));
}
`;
