import { FragmentShader, glsl, Shader } from './shader.js';
import { constants, Renderer, Texture2D } from './webgl.js';
import { WebGLFullQuadPass } from './WebGLFullQuadPass.js';
import {
  JNLM_DEFAULT_COLOR_SENSITIVITY,
  JNLM_ALBEDO_FLOOR,
  JNLM_ALBEDO_REGULARIZATION,
  JNLM_DEFAULT_SHAPE,
  JNLM_COVERAGE_BANDWIDTH,
  JNLM_MAX_ITERATIONS,
  jnlmPassDilation,
  type JNLMFilterShape
} from './jnlm.js';

/**
 * WebGL 2 passes of the JNLM denoiser described in `jnlm.ts`, matching
 * WGPUJNLMDenoiser. Textures replace its storage buffers.
 */

/**
 * The guide mean and the variance of that mean. The main and catcher trace
 * passes each accumulate (sum, sum of squares, count) for their own samples.
 */
const guideFragment = new FragmentShader({
  name: 'jnlmGuide',
  outputs: ['guide'],
  uniforms: {
    momentsTex: Shader.uniform('sampler2D'),
    catcherMomentsTex: Shader.uniform('sampler2D')
  },
  main: glsl`
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 moments = texelFetch(momentsTex, p, 0) + texelFetch(catcherMomentsTex, p, 0);
  float n = moments.z;
  float mean = moments.x / max(n, 1.0);
  // Variance of the mean, or -1 when one sample cannot estimate it.
  float variance = n >= 2.0
    ? max(moments.y - n * mean * mean, 0.0) / (n * (n - 1.0))
    : -1.0;
  out_guide = vec4(mean, variance, 0.0, 1.0);
}`
});

/**
 * Smooths the noisy per-pixel variance over 3 x 3 pixels. Pixels with a
 * single sample take the spatial variance of their neighborhood instead.
 */
const varianceFragment = new FragmentShader({
  name: 'jnlmVariance',
  outputs: ['guide'],
  uniforms: {
    rawGuideTex: Shader.uniform('sampler2D')
  },
  main: glsl`
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(rawGuideTex, 0);
  vec2 center = texelFetch(rawGuideTex, p, 0).xy;
  float varianceSum = 0.0;
  float varianceCount = 0.0;
  float meanSum = 0.0;
  float meanSquareSum = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec2 value = texelFetch(rawGuideTex, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0).xy;
      meanSum += value.x;
      meanSquareSum += value.x * value.x;
      if (value.y >= 0.0) {
        varianceSum += value.y;
        varianceCount += 1.0;
      }
    }
  }
  float variance;
  if (center.y >= 0.0) {
    variance = varianceSum / varianceCount;
  } else {
    float spatialMean = meanSum / 9.0;
    variance = max(meanSquareSum / 9.0 - spatialMean * spatialMean, 0.0) * 9.0 / 8.0;
  }
  out_guide = vec4(center.x, variance, 0.0, 1.0);
}`
});

/**
 * One joint NL-means pass; see createJNLMFilterWGSL. The first pass decodes
 * the display-encoded composition to linear light, the last encodes it again.
 */
const filterFragment = new FragmentShader({
  name: 'jnlmFilter',
  outputs: ['color', 'guide'],
  defines: {
    SEARCH_RADIUS: JNLM_DEFAULT_SHAPE.searchRadius,
    PATCH_RADIUS: JNLM_DEFAULT_SHAPE.patchRadius,
    INV_ALBEDO_BANDWIDTH2: (1 / JNLM_DEFAULT_SHAPE.albedoBandwidth ** 2).toFixed(6),
    INV_NORMAL_BANDWIDTH2: (1 / JNLM_DEFAULT_SHAPE.normalBandwidth ** 2).toFixed(6)
  },
  uniforms: {
    guideTex: Shader.uniform('sampler2D'),
    colorTex: Shader.uniform('sampler2D'),
    albedoTex: Shader.uniform('sampler2D'),
    normalTex: Shader.uniform('sampler2D'),
    shadowCatcherTex: Shader.uniform('sampler2D'),
    colorSensitivity: Shader.uniform('float', JNLM_DEFAULT_COLOR_SENSITIVITY),
    dilation: Shader.uniform('int', 1),
    decodeInput: Shader.uniform('bool', 0),
    encodeOutput: Shader.uniform('bool', 0)
  },
  main: glsl`
#define PATCH_SIZE ((2 * PATCH_RADIUS + 1) * (2 * PATCH_RADIUS + 1))
// Variance cancellation strength alpha of the paper.
#define VARIANCE_CANCELLATION 1.0
// Lower bound of the center weight, so a pixel unlike all of its neighbors
// (a thin highlight) is kept rather than replaced by them.
#define CENTER_WEIGHT_MIN 0.01
#define INV_COVERAGE_BANDWIDTH2 ${(1 / JNLM_COVERAGE_BANDWIDTH ** 2).toFixed(6)}

ivec2 imageSize;

vec2 loadGuide(ivec2 p) {
  return texelFetch(guideTex, clamp(p, ivec2(0), imageSize - 1), 0).xy;
}

// Premultiplied linear color.
vec4 loadColor(ivec2 p) {
  vec4 c = texelFetch(colorTex, p, 0);
  if (decodeInput) c.rgb = pow(max(c.rgb, 0.0), vec3(2.2));
  return vec4(c.rgb * c.a, c.a);
}

float featureDistance(ivec2 q, vec4 centerAlbedo, vec3 centerNormal) {
  vec4 albedo = texelFetch(albedoTex, q, 0);
  // Match WebGPU: protect relative RGB contrast, including dark textures,
  // while keeping coverage differences in absolute units.
  vec3 albedoScale = max((albedo.rgb + centerAlbedo.rgb) * 0.5, vec3(${JNLM_ALBEDO_FLOOR}));
  vec3 albedoDelta = (albedo.rgb - centerAlbedo.rgb) / albedoScale;
  float coverageDelta = albedo.a - centerAlbedo.a;
  vec3 normalDelta = texelFetch(normalTex, q, 0).rgb - centerNormal;
  return max(
    dot(albedoDelta, albedoDelta) * INV_ALBEDO_BANDWIDTH2
      + coverageDelta * coverageDelta * INV_COVERAGE_BANDWIDTH2,
    dot(normalDelta, normalDelta) * INV_NORMAL_BANDWIDTH2
  );
}

void main() {
  imageSize = textureSize(guideTex, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 centerAlbedo = texelFetch(albedoTex, p, 0);
  vec4 centerNormalTexel = texelFetch(normalTex, p, 0);
  vec3 centerNormal = centerNormalTexel.rgb;
  // Primary misses show the background directly. It has no features that
  // protect its detail and no noise beyond antialiasing, so keep it.
  if (centerNormalTexel.a <= 0.0 && texelFetch(shadowCatcherTex, p, 0).r <= 0.0) {
    vec4 c = loadColor(p);
    vec3 rgb = c.rgb / max(c.a, 1e-6);
    if (encodeOutput) rgb = pow(max(rgb, 0.0), vec3(1.0 / 2.2));
    out_color = vec4(rgb, c.a);
    out_guide = vec4(loadGuide(p), 0.0, 1.0);
    return;
  }

  vec2 centerPatch[PATCH_SIZE];
  int k = 0;
  for (int dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (int dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      centerPatch[k] = loadGuide(p + ivec2(dx, dy) * dilation);
      k++;
    }
  }
  float k2 = colorSensitivity * colorSensitivity;

  vec4 sum = vec4(0.0);
  vec3 featureScale = max(centerAlbedo.rgb, vec3(${JNLM_ALBEDO_FLOOR}));
  vec3 featureSum = vec3(0.0);
  vec3 featureSquareSum = vec3(0.0);
  vec3 featureColorSum = vec3(0.0);
  float guideSum = 0.0;
  float guideVarianceSum = 0.0;
  float weightSum = 0.0;
  float maxWeight = 0.0;
  for (int sy = -SEARCH_RADIUS; sy <= SEARCH_RADIUS; sy++) {
    for (int sx = -SEARCH_RADIUS; sx <= SEARCH_RADIUS; sx++) {
      ivec2 q = p + ivec2(sx, sy) * dilation;
      if (
        (sx == 0 && sy == 0) ||
        q.x < 0 || q.y < 0 || q.x >= imageSize.x || q.y >= imageSize.y
      ) continue;
      float features = featureDistance(q, centerAlbedo, centerNormal);
      if (features > 16.0) continue;

      float colorDistance = 0.0;
      k = 0;
      for (int dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
        for (int dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
          vec2 a = centerPatch[k];
          vec2 b = loadGuide(q + ivec2(dx, dy) * dilation);
          float delta = a.x - b.x;
          colorDistance += (delta * delta
              - VARIANCE_CANCELLATION * (a.y + min(a.y, b.y)))
            / (1e-10 + k2 * (a.y + b.y));
          k++;
        }
      }
      colorDistance /= float(PATCH_SIZE);

      float weight = exp(-max(max(colorDistance, 0.0), features));
      vec2 g = loadGuide(q);
      // Filter premultiplied color so coverage and color stay consistent.
      vec3 a = (texelFetch(albedoTex, q, 0).rgb - centerAlbedo.rgb) / featureScale;
      vec4 value = loadColor(q);
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
  vec4 center = loadColor(p);
  vec2 centerGuide = loadGuide(p);
  float centerWeight = max(maxWeight, CENTER_WEIGHT_MIN);
  float totalWeight = weightSum + centerWeight;
  vec4 mean = (sum + center * centerWeight) / totalWeight;
  // Fit each color channel against relative albedo with the same JNLM weights.
  // Centering at this pixel avoids cancellation when the feature is constant.
  vec3 meanFeature = featureSum / totalWeight;
  vec3 featureVariance = max(featureSquareSum / totalWeight - meanFeature * meanFeature, vec3(0.0));
  vec3 covariance = featureColorSum / totalWeight - meanFeature * mean.rgb;
  // A 1% contrast ridge stabilizes flat guides. Bound the response between no
  // texture dependence and multiplicative albedo modulation; specular color
  // with an unrelated albedo falls back to the weighted mean.
  vec3 meanAlbedo = centerAlbedo.rgb + meanFeature * featureScale;
  vec3 maximumSlope = mean.rgb * featureScale / max(meanAlbedo, vec3(${JNLM_ALBEDO_FLOOR}));
  vec3 slope = clamp(covariance / (featureVariance + vec3(${JNLM_ALBEDO_REGULARIZATION})), vec3(0.0), maximumSlope);
  vec3 corrected = mean.rgb - slope * meanFeature;
  vec4 filtered = vec4(max(corrected, vec3(0.0)), max(mean.a, 0.0));
  vec3 rgb = filtered.a > 1e-6
    ? filtered.rgb / max(filtered.a, 1e-6)
    : center.rgb / max(center.a, 1e-6);
  if (encodeOutput) rgb = pow(max(rgb, 0.0), vec3(1.0 / 2.2));
  out_color = vec4(rgb, filtered.a);
  out_guide = vec4(
    (guideSum + centerGuide.x * centerWeight) / totalWeight,
    (guideVarianceSum + centerGuide.y * centerWeight * centerWeight)
      / (totalWeight * totalWeight),
    0.0,
    1.0
  );
}`
});

export interface WebGLJNLMInputs {
  width: number;
  height: number;
  /** Main trace pass moments: guide sum, sum of squares and count. */
  moments: Texture2D;
  /** Catcher trace pass moments, when the scene has a shadow catcher. */
  catcherMoments?: Texture2D;
  /** Display-encoded composition to filter. */
  color: Texture2D;
  albedo: Texture2D;
  normal: Texture2D;
  /** Normalized shadow-catcher mask; red is the catcher coverage. */
  shadowCatcher: Texture2D;
  strength: number;
  shape: JNLMFilterShape;
}

const floatOutput = {
  type: constants.FLOAT,
  minFilter: constants.NEAREST,
  magFilter: constants.NEAREST
};

export class WebGLJNLMDenoisePass {
  private _renderer: Renderer;
  private _guidePass: WebGLFullQuadPass<'momentsTex' | 'catcherMomentsTex', 'guide'>;
  private _variancePass: WebGLFullQuadPass<'rawGuideTex', 'guide'>;
  // Two instances so consecutive passes ping-pong between their outputs.
  private _filterPasses: WebGLFullQuadPass<
    'guideTex' | 'colorTex' | 'albedoTex' | 'normalTex' | 'shadowCatcherTex',
    'color' | 'guide'
  >[];

  constructor(renderer: Renderer) {
    this._renderer = renderer;
    this._guidePass = new WebGLFullQuadPass('jnlmGuide', renderer, {
      shader: guideFragment,
      outputParams: { guide: floatOutput }
    });
    this._variancePass = new WebGLFullQuadPass('jnlmVariance', renderer, {
      shader: varianceFragment,
      outputParams: { guide: floatOutput }
    });
    this._filterPasses = [0, 1].map(() =>
      new WebGLFullQuadPass('jnlmFilter', renderer, {
        shader: filterFragment,
        outputParams: {
          color: { type: constants.HALF_FLOAT },
          guide: floatOutput
        }
      })
    );
  }

  /** Runs the denoiser and returns the display-encoded result. */
  render(inputs: WebGLJNLMInputs): Texture2D {
    const { width, height, shape } = inputs;
    const passes = [this._guidePass, this._variancePass, ...this._filterPasses];
    passes.forEach((pass) => pass.setSize(width, height));
    this._guidePass.createPass({
      momentsTex: inputs.moments,
      catcherMomentsTex: inputs.catcherMoments ?? this._renderer.emptyTexture
    });
    this._variancePass.createPass({ rawGuideTex: this._guidePass.getOutput('guide') });

    const sensitivity = JNLM_DEFAULT_COLOR_SENSITIVITY * Math.max(inputs.strength, 1e-3);
    const iterations = Math.min(JNLM_MAX_ITERATIONS, Math.max(1, Math.round(shape.iterations)));
    let guide = this._variancePass.getOutput('guide');
    let color = inputs.color;
    for (let i = 0; i < iterations; i++) {
      const pass = this._filterPasses[i % 2];
      pass.setDefines({
        SEARCH_RADIUS: shape.searchRadius,
        // Numeric zero removes a define in the WebGL shader builder.
        PATCH_RADIUS: String(shape.patchRadius),
        INV_ALBEDO_BANDWIDTH2: (1 / shape.albedoBandwidth ** 2).toFixed(6),
        INV_NORMAL_BANDWIDTH2: (1 / shape.normalBandwidth ** 2).toFixed(6)
      });
      pass.setUniforms({
        colorSensitivity: sensitivity,
        dilation: jnlmPassDilation(i),
        decodeInput: i === 0,
        encodeOutput: i === iterations - 1
      });
      pass.createPass({
        guideTex: guide,
        colorTex: color,
        albedoTex: inputs.albedo,
        normalTex: inputs.normal,
        shadowCatcherTex: inputs.shadowCatcher
      });
      guide = pass.getOutput('guide');
      color = pass.getOutput('color');
    }
    return color;
  }

  retainOutput(texture: Texture2D) { this._filterPasses.forEach(pass => pass.retainOutput(texture)); }
  releaseOutput(texture: Texture2D) { this._filterPasses.forEach(pass => pass.releaseOutput(texture)); }

  getMemoryBytes() {
    return [this._guidePass, this._variancePass, ...this._filterPasses]
      .reduce((sum, pass) => sum + pass.getMemoryBytes(), 0);
  }

  dispose() {
    [this._guidePass, this._variancePass, ...this._filterPasses].forEach((pass) =>
      pass.dispose()
    );
  }
}
