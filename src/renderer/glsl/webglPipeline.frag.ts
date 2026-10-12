import { FragmentShader, Shader, glsl } from '../shader.js';

export const brightFragment = new FragmentShader({
  name: 'bloomBright',
  uniforms: {
    colorTex: Shader.uniform('sampler2D'),
    threshold: Shader.uniform('float', 1),
    scale: Shader.uniform('float', 1)
  },
  main: glsl`
const vec3 lumWeight = vec3(0.2125, 0.7154, 0.0721);
vec4 median(vec4 a, vec4 b, vec4 c) {
  return a + b + c - min(min(a, b), c) - max(max(a, b), c);
}
void main() {
  vec2 d = 1.0 / vec2(textureSize(colorTex, 0));
  vec4 texel = texture(colorTex, v_Texcoord);
  vec4 s1 = texture(colorTex, v_Texcoord - vec2(d.x, 0.0));
  vec4 s2 = texture(colorTex, v_Texcoord + vec2(d.x, 0.0));
  vec4 s3 = texture(colorTex, v_Texcoord - vec2(0.0, d.y));
  vec4 s4 = texture(colorTex, v_Texcoord + vec2(0.0, d.y));
  texel = median(median(texel, s1, s2), s3, s4);
  float lum = dot(texel.rgb, lumWeight);
  out_color = lum > threshold && texel.a > 0.0
    ? vec4(texel.rgb * scale, texel.a)
    : vec4(0.0, 0.0, 0.0, texel.a);
}`
});

export const composeFragment = new FragmentShader({
  name: 'compose',
  uniforms: {
    colorTex: Shader.uniform('sampler2D'),
    foregroundTex: Shader.uniform('sampler2D'),
    catcherBackgroundTex: Shader.uniform('sampler2D'),
    shadowCatcherTex: Shader.uniform('sampler2D'),
    bloomTex: Shader.uniform('sampler2D'),
    exposure: Shader.uniform('float', 1),
    shadowCatcherColor: Shader.uniform('vec3', [0, 0, 0]),
    shadowCatcherAlpha: Shader.uniform('float', 1),
    shadowCatcherEnabled: Shader.uniform('float', 0),
    bloomIntensity: Shader.uniform('float', 0),
    toneMappingMode: Shader.uniform('int', 0),
    contrast: Shader.uniform('float', 1),
    saturation: Shader.uniform('float', 1),
    temperature: Shader.uniform('float', 0),
    tint: Shader.uniform('float', 0),
    vignette: Shader.uniform('float', 0),
    outputMode: Shader.uniform('int', 0),
    sRGBOutput: Shader.uniform('bool', 1)
  },
  main: glsl`
vec3 linearToneMapping(vec3 color) {
  return clamp(color, 0.0, 1.0);
}
vec3 reinhardToneMapping(vec3 color) {
  return clamp(color / (vec3(1.0) + color), 0.0, 1.0);
}
vec3 cineonToneMapping(vec3 color) {
  color = max(vec3(0.0), color - 0.004);
  return pow((color * (6.2 * color + 0.5)) /
    (color * (6.2 * color + 1.7) + 0.06), vec3(2.2));
}
vec3 rrtAndOdtFit(vec3 value) {
  vec3 numerator = value * (value + 0.0245786) - 0.000090537;
  vec3 denominator = value * (0.983729 * value + 0.4329510) + 0.238081;
  return numerator / denominator;
}
vec3 acesToneMapping(vec3 color) {
  const mat3 inputMatrix = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777)
  );
  const mat3 outputMatrix = mat3(
    vec3(1.60475, -0.10208, -0.00327),
    vec3(-0.53108, 1.10813, -0.07276),
    vec3(-0.07367, -0.00605, 1.07602)
  );
  color = inputMatrix * (color / 0.6);
  return clamp(outputMatrix * rrtAndOdtFit(color), 0.0, 1.0);
}
const mat3 LINEAR_REC2020_TO_LINEAR_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182),
  vec3(-0.5876, 1.1329, -0.1006),
  vec3(-0.0728, -0.0083, 1.1187)
);
const mat3 LINEAR_SRGB_TO_LINEAR_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164),
  vec3(0.3293, 0.9195, 0.0880),
  vec3(0.0433, 0.0113, 0.8956)
);
vec3 agxDefaultContrastApprox(vec3 value) {
  vec3 value2 = value * value;
  vec3 value4 = value2 * value2;
  return 15.5 * value4 * value2 - 40.14 * value4 * value
    + 31.96 * value4 - 6.868 * value2 * value
    + 0.4298 * value2 + 0.1191 * value - 0.00232;
}
vec3 agxToneMapping(vec3 color) {
  const mat3 insetMatrix = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859)
  );
  const mat3 outsetMatrix = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405)
  );
  color = insetMatrix * (LINEAR_SRGB_TO_LINEAR_REC2020 * color);
  color = clamp((log2(max(color, 1e-10)) + 12.47393) / 16.5, 0.0, 1.0);
  color = outsetMatrix * agxDefaultContrastApprox(color);
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(LINEAR_REC2020_TO_LINEAR_SRGB * color, 0.0, 1.0);
}
vec3 applyToneMapping(vec3 color) {
  if (toneMappingMode == 1) return acesToneMapping(color);
  if (toneMappingMode == 2) return cineonToneMapping(color);
  if (toneMappingMode == 3) return reinhardToneMapping(color);
  if (toneMappingMode == 4) return linearToneMapping(color);
  return agxToneMapping(color);
}
vec3 gradeColor(vec3 color) {
  vec3 balance = vec3(
    1.0 + temperature * 0.16 + tint * 0.04,
    1.0 - tint * 0.12,
    1.0 - temperature * 0.16 + tint * 0.04
  );
  color = max(color * balance, 0.0);
  color = max((color - 0.18) * contrast + 0.18, 0.0);
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  return max(mix(vec3(luminance), color, saturation), 0.0);
}
void main() {
  vec2 uv = v_Texcoord;
  vec4 shadow = texture(shadowCatcherTex, uv);
  if (outputMode == 1) {
    out_color = vec4(vec3(shadow.a), 1.0);
    return;
  }

  vec4 color = texture(colorTex, uv);
  vec4 bloom = texture(bloomTex, uv) * bloomIntensity;
  color.rgb += bloom.rgb;
  color.rgb = gradeColor(color.rgb * exposure);
  if (sRGBOutput) {
    float edge = smoothstep(0.2, 0.72, distance(uv, vec2(0.5)));
    color.rgb *= 1.0 - vignette * edge;
    color.rgb = applyToneMapping(color.rgb);
    color.rgb = pow(max(color.rgb, 0.0), vec3(1.0 / 2.2));
  }
  color.a = max(color.a, min(dot(bloom.rgb, vec3(0.2125, 0.7154, 0.0721)), 1.0));

  if (shadowCatcherEnabled > 0.5) {
    float coverage = clamp(shadow.r, 0.0, 1.0);
    // Non-catcher samples contribute visibility 1. Undo primary coverage
    // before adjusting opacity, then apply the coverage exactly once.
    float shadowAlpha = clamp(
      (1.0 - shadow.a) / max(coverage, 0.000001), 0.0, 1.0
    );
    shadowAlpha = max(shadowAlpha - (1.0 - shadowCatcherAlpha), 0.0);
    if (coverage > 0.0) {
      vec4 foreground = texture(foregroundTex, uv);
      vec4 background = texture(catcherBackgroundTex, uv);
      vec3 foregroundColor = gradeColor((foreground.rgb + bloom.rgb) * exposure);
      vec3 backgroundColor = gradeColor((background.rgb / max(background.a, 0.000001) + bloom.rgb) * exposure);
      if (sRGBOutput) {
        float edge = smoothstep(0.2, 0.72, distance(uv, vec2(0.5)));
        foregroundColor *= 1.0 - vignette * edge;
        backgroundColor *= 1.0 - vignette * edge;
        foregroundColor = pow(max(applyToneMapping(foregroundColor), 0.0), vec3(1.0 / 2.2));
        backgroundColor = pow(max(applyToneMapping(backgroundColor), 0.0), vec3(1.0 / 2.2));
      }
      // The primary samples belong to disjoint layers. Never shadow the model.
      float opacity = shadowAlpha;
      shadowAlpha *= coverage;
      float bloomAlpha = clamp(dot(bloom.rgb, vec3(0.2125, 0.7154, 0.0721)), 0.0, 1.0);
      float foregroundAlpha = max(foreground.a, bloomAlpha * (1.0 - coverage));
      float backgroundAlpha = max(background.a, bloomAlpha * coverage);
      float alpha = foregroundAlpha + backgroundAlpha * (1.0 - opacity) + shadowAlpha;
      vec3 premultiplied = foregroundColor * foregroundAlpha
        + backgroundColor * backgroundAlpha * (1.0 - opacity)
        + shadowCatcherColor * shadowAlpha;
      color = vec4(premultiplied / max(alpha, 0.000001), alpha);
    }
  }
  out_color = color;
}`
});

export const outputFragment = new FragmentShader({
  name: 'output',
  uniforms: {
    colorTex: Shader.uniform('sampler2D'),
    colorDenoisedTex: Shader.uniform('sampler2D'),
    denoisedPercent: Shader.uniform('float', 0)
  },
  main: glsl`
void main() {
  vec2 uv = v_Texcoord;
  vec4 color = mix(
    texture(colorTex, uv),
    texture(colorDenoisedTex, uv),
    denoisedPercent
  );
  color = vec4(color.rgb * color.a, color.a);
  out_color = color;
}`
});
